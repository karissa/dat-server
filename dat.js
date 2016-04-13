var path = require('path')
var debug = require('debug')('dat')
var walker = require('folder-walker')
var hyperdrive = require('hyperdrive')
var speedometer = require('speedometer')
var pump = require('pump')
var each = require('stream-each')
var through = require('through2')
var discoverySwarm = require('discovery-swarm')
var events = require('events')

module.exports = Dat

var DEFAULT_PORT = 3282
var DEFAULT_DISCOVERY = [
  'discovery1.publicbits.org',
  'discovery2.publicbits.org'
]
var DAT_DOMAIN = 'dat.local'

function Dat (opts) {
  if (!(this instanceof Dat)) return new Dat(opts)
  if (!opts) opts = {}
  var self = this
  this.fs = opts.fs || require('./fs.js')
  this.level = opts.db || require('./db.js')(opts)
  var drive = hyperdrive(this.level)
  this.drive = drive
  this.allPeers = {}
  this.blacklist = {}
  this.status = {}

  var discovery = opts.discovery !== false
  this.swarm = discoverySwarm({
    id: drive.core.id,
    dns: discovery && {server: DEFAULT_DISCOVERY, domain: DAT_DOMAIN},
    dht: discovery,
    stream: function () {
      return drive.createPeerStream()
    }
  })
  this.swarm.listen(opts.port || DEFAULT_PORT)
  this.swarm.once('error', function (err) {
    if (err.code === 'EADDRINUSE') self.swarm.listen(0) // asks OS for first open port
    else throw err
  })
}

Dat.DNS_SERVERS = DEFAULT_DISCOVERY

Dat.prototype.scan = function (dirs, onEach, cb) {
  var stream = walker(dirs, {filter: function (data) {
    if (path.basename(data) === '.dat') return false
    return true
  }})

  each(stream, function (data, next) {
    var item = {
      name: data.relname,
      path: path.resolve(data.filepath),
      mtime: data.stat.mtime.getTime(),
      ctime: data.stat.ctime.getTime(),
      size: data.stat.size,
      root: data.root
    }

    var isFile = data.stat.isFile()
    if (isFile) {
      item.type = 'file'
    }
    var isDir = data.stat.isDirectory()
    if (isDir) item.type = 'directory'
    onEach(item, next)
  }, cb)
}

Dat.prototype.fileStats = function (dir, cb) {
  this.scan(dir, eachItem, done)

  var totalStats = {
    filesTotal: 0,
    directories: 0,
    bytesTotal: 0,
    latest: null
  }

  function eachItem (item, next) {
    if (item.type === 'file') {
      totalStats.filesTotal++
      totalStats.bytesTotal += item.size
      if (item.mtime > totalStats.latest) totalStats.latest = item.mtime
    } else if (item.type === 'directory') {
      totalStats.directories++
    }
    next()
  }

  function done (err) {
    if (err) return cb(err)
    cb(null, totalStats)
  }
}

Dat.prototype.link = function (dir, cb) {
  if (Array.isArray(dir)) throw new Error('cannot specify multiple dirs in .link')
  var archive = this.drive.add('.')
  this.scan(dir, eachItem, done)
  var emitter = new events.EventEmitter()

  var stats = this.status[dir] = {
    progress: {
      bytesRead: 0,
      bytesDownloaded: 0,
      filesRead: 0,
      filesDownloaded: 0
    },
    uploaded: {
      bytesRead: 0
    },
    fileQueue: []
  }

  var uploadRate = speedometer()
  archive.on('file-upload', function (entry, data) {
    stats.uploaded.bytesRead += data.length
    stats.uploadRate = uploadRate(data.length)
    emitter.emit('stats')
  })

  return emitter

  function eachItem (item, next) {
    if (item.path === item.root.slice(0, item.root.length - 1)) return next()
    var appendStats = archive.appendFile(item.path, item.name, next)
    // This could accumulate too many objects if
    // logspeed is slow & scanning many files.
    if (item.type === 'file') {
      stats.fileQueue.push({
        name: item.name,
        stats: appendStats
      })
      appendStats.on('end', function () {
        stats.progress.filesRead += 1
        stats.progress.bytesRead += appendStats.bytesRead
        emitter.emit('stats')
      })
    }
  }

  function done (err) {
    if (err) return cb(err)
    archive.finalize(function (err) {
      if (err) return cb(err)
      var link = archive.id.toString('hex')
      emitter.emit('stats')
      cb(null, link)
    })
  }
}

Dat.prototype.leave = function (link) {
  link = this._normalize(link)
  var key = new Buffer(link, 'hex')
  debug('leaving', link, key)
  this.swarm.leave(key)
}

Dat.prototype.close = function (cb) {
  var self = this
  this.drive.core.db.close(function (err) {
    if (err) return cb(err)
    self.swarm.destroy(cb)
  })
}

Dat.prototype._normalize = function (link) {
  return link.replace('dat://', '').replace('dat:', '')
}

Dat.prototype.get = function (link, dir) {
  var key = this._normalize(link)
  return this.drive.get(key, dir)
}

// returns object that is used to render progress bars
Dat.prototype.join = function (link, dir, opts, cb) {
  var self = this
  if ((typeof opts) === 'function') return this.join(link, dir, {}, opts)
  if (!opts) opts = {}
  if (!cb) cb = function noop () {}
  var emitter = new events.EventEmitter()

  var stats = emitter.stats = {
    progress: {
      bytesRead: 0,
      filesRead: 0
    },
    total: {
      bytesTotal: 0,
      filesTotal: 0,
      directories: 0
    },
    uploaded: {
      bytesRead: 0
    },
    fileQueue: []
  }
  link = this._normalize(link)
  self.swarm.join(new Buffer(link, 'hex'))
  var downloadRate = speedometer()
  var uploadRate = speedometer()
  var archive = self.get(link, dir)

  archive.on('file-upload', function (entry, data) {
    stats.uploaded.bytesRead += data.length
    stats.uploadRate = uploadRate(data.length)
    emitter.emit('stats')
  })

  archive.ready(function (err) {
    if (err) return cb(err)
    var download = self.fs.createDownloadStream(archive, stats, opts)
    var counter = through.obj(function (item, enc, next) {
      if (typeof stats.parentFolder === 'undefined') {
        var segments = item.name.split(path.sep)
        if (segments.length === 1 && item.type === 'file') stats.parentFolder = false
        else stats.parentFolder = segments[0]
      }
      stats.total.bytesTotal += item.size
      if (item.type === 'file') stats.total.filesTotal++
      else stats.total.directories++
      emitter.emit('data', stats)
      next(null)
    })
    pump(archive.createEntryStream(), counter, function (err) {
      if (err) return cb(err)
      stats.hasMetadata = true
      emitter.emit('data', stats)
      downloadStream()
    })

    function downloadStream () {
      pump(archive.createEntryStream(), download, function (err) {
        cb(err)
      })
    }
  })

  archive.on('file-download', function (entry, data, block) {
    stats.progress.bytesRead += data.length
    stats.downloadRate = downloadRate(data.length)
    emitter.emit('data', stats)
  })

  return emitter
}

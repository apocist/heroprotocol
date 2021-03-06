"use strict";

const fs = require('fs-extra');
const klawSync = require('klaw-sync');
const path = require('path');
const download = require("download-github-repo");

const _data = require(path.normalize(__dirname+'/lib/data'));
const _template = path.normalize(__dirname+'/config/protocol.js.template');

const repositories = ['Blizzard/heroprotocol', 'Blizzard/s2protocol'];
const cloneDir = path.normalize(__dirname+'/src');
const outDir = path.normalize(__dirname+'/lib');

const minimumProtocolVersion = 29406;

function getProtocols() {
  return Promise.all(repositories.map(repository => {
    return new Promise((resolve, reject) => {
      const repoDir = path.normalize(path.join(cloneDir, repository));

      fs.mkdirp(repoDir, err => {
        if (err) reject;

        fs.readdir(cloneDir, (err, contents) => {
          if (err) reject;

          console.log("Downloading https://github.com/" + repository + " ...");

          download(repository, repoDir, err => {
            if (!err)
              resolve();
            else {
              console.error(err);
              console.error("Error downloading https://github.com/" + repository);
              process.exit(1);
            }
          });
        });
      });
    });
  }));
}

const types = {
  tuple: function (str) {
    return str.match(/(-?\w+)/g);
  },
  tuples: function (str) {
    return str.match(/(\(.*?\))/g);
  },
  _int: {
    decode: function (str) {
      const ret = { };
      const res = types.tuple(str);
      ret.bounds = [res[0], res[1]];
      return ret;
    },
    encode: function (infos) {
      return `[${infos.bounds[0]}, ${infos.bounds[1]}]`;
    }
  },
  _choice: {
    decode: function (str) {
      const ret = { bounds: [], choices: [] };
      let res = types.tuples(str);

      Object.assign(ret, types._int.decode(res[0]));
      for (let i = 1; i < res.length; i += 1) {
        const tuple = types.tuple(res[i]);
        ret.choices.push({
          label: tuple[0],
          typeIndex: tuple[1]
        });
      }
      return ret;
    },
    encode: function (infos) {
      return `[${infos.bounds[0]}, ${infos.bounds[1]}], { ${infos.choices.map((choice, index, ar) => {
        return `${index}: ['${choice.label}', ${choice.typeIndex}]${(index === ar.length - 1) ? '' : ', '}`;
      }).join('')}}`;
    }
  },
  _struct: {
    decode: function (str) {
      const ret = { items: [] };
      const tuples = types.tuples(str);
      if (tuples) {
        tuples.forEach(tuple => {
          tuple = types.tuple(tuple);
          ret.items.push({
            label: tuple[0],
            typeIndex: tuple[1],
            tag: tuple[2]
          });
        });
      }
      return ret;
    },
    encode: function (infos) {
      return `[${infos.items.map((item, index, ar) => {
        return `['${item.label}', ${item.typeIndex}, ${item.tag}]${(index === ar.length - 1) ? '' : ', '}`;
      }).join('')}]`;
    }
  },
  _blob: {
    decode: function (str) {
      return types._int.decode(str);
    },
    encode: function (infos) {
      return types._int.encode(infos);
    }
  },
  _bool: {
    decode: function (str) {
      return {};
    },
    encode: function (infos) {
      return '';
    }
  },
  _array: {
    decode: function (str) {
      return Object.assign(
        { typeIndex: str.match(/\d+$/)[0] },
        types._int.decode(str)
      );
    },
    encode: function (infos) {
      return `[${infos.bounds[0]}, ${infos.bounds[1]}], ${infos.typeIndex}`;
    }
  },
  _optional: {
    decode: function (str) {
      return { typeIndex: Number(str) };
    },
    encode: function (infos) {
      return `${infos.typeIndex}`;
    }
  },
  _fourcc: {
    decode: function (str) {
      return {};
    },
    encode: function (infos) {
      return '';
    }
  },
  _bitarray: {
    decode: function (str) {
      return types._int.decode(str);
    },
    encode: function (infos) {
      return types._int.encode(infos);
    }
  },
  _null: {
    decode: function (str) {
      return {};
    },
    encode: function (infos) {
      return '';
    }
  }
};

const tokens = {
  newline: '\n',
  indent: '  ',
  typeinfosStart: 'typeinfos = [',
  typeinfosEnd: ']',
  gameeventsStart: 'game_event_types = {',
  gameeventsEnd: '}',
  messageeventsStart: 'message_event_types = {',
  messageeventsEnd: '}',
  trackereventsStart: 'tracker_event_types = {',
  trackereventsEnd: '}',
  gameeventsTypeid: 'game_eventid_typeid =',
  messageeventsTypeid: 'message_eventid_typeid =',
  trackereventsTypeid: 'tracker_eventid_typeid =',
  headerTypeid: 'replay_header_typeid =',
  detailsTypeid: 'game_details_typeid =',
  initdataTypeid: 'replay_initdata_typeid ='
};

const Protocol = exports.Protocol = class {
  constructor(file) {
    this.file = file;
    this.name = path.basename(file);
    this.jsName = this.name.replace(/\.py$/, '.js');
    this.version = Number(file.match(/(\d+)\.py$/)[1]);
  }

  parse() {
    return new Promise((resolve, reject) => {
      fs.readFile(this.file, 'utf8', (err, raw) => {
        if (err) return reject(err);

        const lines = raw.split(tokens.newline);

        let line = 0, str;

        this.typeinfos = [];
        this.gameeventsTypes = [];
        this.messageeventsTypes = [];
        this.trackereventstypes = [];

        while (line < lines.length) {
          str = lines[line].trim();

          if (str === tokens.typeinfosStart) {
            line += 1;
            str = lines[line].trim();
            do {
              this.typeinfos.push(this.parseTypeinfos(str));
              line += 1;
              str = lines[line].trim();
            } while (str !== tokens.typeinfosEnd);
          } else if (tokens.gameeventsStart === str) {
            line += 1;
            str = lines[line].trim();
            do {
              this.gameeventsTypes.push(this.parseEvent(str));
              line += 1;
              str = lines[line].trim();
            } while (tokens.gameeventsEnd !== str);
          } else if (tokens.messageeventsStart === str) {
            line += 1;
            str = lines[line].trim();
            do {
              this.messageeventsTypes.push(this.parseEvent(str));
              line += 1;
              str = lines[line].trim();
            } while (tokens.messageeventsEnd !== str);
          } else if (tokens.trackereventsStart === str) {
            line += 1;
            str = lines[line].trim();
            do {
              this.trackereventstypes.push(this.parseEvent(str));
              line += 1;
              str = lines[line].trim();
            } while (tokens.trackereventsEnd !== str);
          } else if (str.startsWith(tokens.gameeventsTypeid)) {
            this.gameeventsTypeid = str.match(/\d+/)[0];
          } else if (str.startsWith(tokens.messageeventsTypeid)) {
            this.messageeventsTypeid = str.match(/\d+/)[0];
          } else if (str.startsWith(tokens.trackereventsTypeid)) {
            this.trackereventsTypeid = str.match(/\d+/)[0];
          } else if (str.startsWith(tokens.headerTypeid)) {
            this.headerTypeid = str.match(/\d+/)[0];
          } else if (str.startsWith(tokens.detailsTypeid)) {
            this.detailsTypeid = str.match(/\d+/)[0];
          } else if (str.startsWith(tokens.initdataTypeid)) {
            this.initdataTypeid = str.match(/\d+/)[0];
          }

          line += 1;
        }
        resolve();
      });
    });
  }

  parseTypeinfos(str) {
    const typeRegex = /^\('(.*?)',\[(.*)\]\),\s*#(\d+)$/;
    const infos = { str: str };
    const res = typeRegex.exec(str);

    infos.type = res[1];
    Object.assign(infos, types[infos.type].decode(res[2]));
    infos.index = res[3];

    return infos;
  }

  parseEvent(str) {
    const res = str.match(/^(\d+):\s\((\d+),\s\'(.*)\'/);
    return {
      key: res[1],
      typeIndex: res[2],
      name: res[3]
    };
  }

  write() {
    const buildInfos = _data.builds[this.version];

    let out = fs.readFileSync(_template, 'utf8');
    out = out.replace('${date}', new Date().toUTCString());
    out = out.replace('${version}', this.version);

    if (buildInfos) {
      const patch = buildInfos.live ? buildInfos.live.patch : buildInfos.ptr.patch;
      out = out.replace('${patch}', `exports.patch = \'${patch}\';${tokens.newline}`);
    } else {
      out = out.replace('${patch}', '');
    }

    out = out.replace('${typeinfos}', this.typeinfos.map((infos, index, ar) => {
      let str = tokens.indent;

      str += `['${infos.type}', [`;
      str += types[infos.type].encode(infos);
      str += `]]${index === (ar.length - 1) ? '' : ','}`;
      str += `  //${infos.index}`;

      return str;
    }).join(tokens.newline));

    out = out.replace('${gameeventsTypes}', this.gameeventsTypes.map((event, index, ar) => {
      let str = tokens.indent;

      str += `${event.key}: [${event.typeIndex}, \'${event.name}\']`;
      str += index === ar.length - 1 ? '' : ',';

      return str;
    }).join(tokens.newline));

    out = out.replace('${messageeventsTypes}', this.messageeventsTypes.map((event, index, ar) => {
      let str = tokens.indent;

      str += `${event.key}: [${event.typeIndex}, \'${event.name}\']`;
      str += index === ar.length - 1 ? '' : ',';

      return str;
    }).join(tokens.newline));

    out = out.replace('${trackereventstypes}', this.trackereventstypes.map((event, index, ar) => {
      let str = tokens.indent + tokens.indent;

      str += `${event.key}: [${event.typeIndex}, \'${event.name}\']`;
      str += index === ar.length - 1 ? '' : ',';

      return str;
    }).join(tokens.newline));

    out = out.replace('${gameeventsTypeid}', this.gameeventsTypeid);
    out = out.replace('${messageeventsTypeid}', this.messageeventsTypeid);
    out = out.replace('${trackereventsTypeid}', this.trackereventsTypeid);
    out = out.replace('${headerTypeid}', this.headerTypeid);
    out = out.replace('${detailsTypeid}', this.detailsTypeid);
    out = out.replace('${initdataTypeid}', this.initdataTypeid);

    return new Promise((resolve, reject) => {
      fs.writeFile(`${outDir}/${this.jsName}`, out, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
};

getProtocols().then(() => {
  const files = klawSync(cloneDir, {
    nodir: true,
    filter: file => {
      const match = file.path.match(/protocol(\d+)\.py$/);
      const protocolVersion = match ? parseInt(match[1]) : -1;
      return match && protocolVersion >= minimumProtocolVersion;
    }
  });
  const successes = [];
  const failures = [];

  Promise.all(files.map(file => {
    return new Promise((resolve, reject) => {
      const proto = new Protocol(file.path);
      proto.parse().then(() => {
        proto.write().then(() => {
          successes.push(proto.jsName);
          resolve();
        }, err => {
          failures.push(proto.jsName);
          resolve();
        });
      }, err => {
        failures.push(proto.jsName);
        resolve();
      });
    });
  })).then(() => {
    successes.sort().map(file => {
      console.log('SUCCESS:', file);
    });
    failures.sort().map(file => {
      console.error('FAILED:', file);
    });
    if (failures.length > 0)
      process.exit(2);
  }).catch(console.log);
}, () => {
  console.error('Failed to fetch files from', repositories);
  process.exit(1);
});

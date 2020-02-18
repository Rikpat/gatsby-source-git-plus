const Git = require("nodegit");
const { createFileNode } = require("gatsby-source-filesystem/create-file-node");
const GitUrlParse = require("git-url-parse");
const path = require("path");
const chokidar = require(`chokidar`);
const { Machine, interpret } = require(`xstate`);

/**
 * Create a state machine to manage Chokidar's not-ready/ready states.
 */
const createFSMachine = (
  { actions: { createNode, deleteNode }, getNode, createNodeId, reporter },
  name,
  localPath,
  remoteId,
  fileCommits
) => {
  const createAndProcessNode = path => {
    return createFileNode(path, createNodeId, {
      name: name,
      path: localPath
    }).then(fileNode => {
      // Add a link to the git remote node
      fileNode.gitRemote___NODE = remoteId;
      fileNode.gitCommit___NODE = fileCommits[fileNode.relativePath];
      return createNode(fileNode, {
        name: `gatsby-source-filesystem`
      });
    });
  };

  const deletePathNode = path => {
    const node = getNode(createNodeId(path));
    // It's possible the node was never created as sometimes tools will
    // write and then immediately delete temporary files to the file system.
    if (node) {
      deleteNode({ node });
    }
  };

  // For every path that is reported before the 'ready' event, we throw them
  // into a queue and then flush the queue when 'ready' event arrives.
  // After 'ready', we handle the 'add' event without putting it into a queue.
  let pathQueue = [];
  const flushPathQueue = () => {
    let queue = pathQueue.slice();
    pathQueue = null;
    return Promise.all(
      // eslint-disable-next-line consistent-return
      queue.map(({ op, path }) => {
        switch (op) {
          case `delete`:
            return deletePathNode(path);
          case `upsert`:
            return createAndProcessNode(path);
        }
      })
    );
  };

  const log = expr => (ctx, action, meta) => {
    if (meta.state.matches(`BOOTSTRAP.BOOTSTRAPPED`)) {
      reporter.info(expr(ctx, action, meta));
    }
  };

  const fsMachine = Machine(
    {
      id: `fs`,
      type: `parallel`,
      states: {
        BOOTSTRAP: {
          initial: `BOOTSTRAPPING`,
          states: {
            BOOTSTRAPPING: {
              on: {
                BOOTSTRAP_FINISHED: `BOOTSTRAPPED`
              }
            },
            BOOTSTRAPPED: {
              type: `final`
            }
          }
        },
        CHOKIDAR: {
          initial: `NOT_READY`,
          states: {
            NOT_READY: {
              on: {
                CHOKIDAR_READY: `READY`,
                CHOKIDAR_ADD: { actions: `queueNodeProcessing` },
                CHOKIDAR_CHANGE: { actions: `queueNodeProcessing` },
                CHOKIDAR_UNLINK: { actions: `queueNodeDeleting` }
              },
              exit: `flushPathQueue`
            },
            READY: {
              on: {
                CHOKIDAR_ADD: {
                  actions: [
                    `createAndProcessNode`,
                    log(
                      (_, { pathType, path }) => `added ${pathType} at ${path}`
                    )
                  ]
                },
                CHOKIDAR_CHANGE: {
                  actions: [
                    `createAndProcessNode`,
                    log(
                      (_, { pathType, path }) =>
                        `changed ${pathType} at ${path}`
                    )
                  ]
                },
                CHOKIDAR_UNLINK: {
                  actions: [
                    `deletePathNode`,
                    log(
                      (_, { pathType, path }) =>
                        `deleted ${pathType} at ${path}`
                    )
                  ]
                }
              }
            }
          }
        }
      }
    },
    {
      actions: {
        createAndProcessNode(_, { pathType, path }) {
          createAndProcessNode(path).catch(err => reporter.error(err));
        },
        deletePathNode(_, { pathType, path }, { state }) {
          deletePathNode(path);
        },
        flushPathQueue(_, { resolve, reject }) {
          flushPathQueue().then(resolve, reject);
        },
        queueNodeDeleting(_, { path }) {
          pathQueue.push({ op: `delete`, path });
        },
        queueNodeProcessing(_, { path }) {
          pathQueue.push({ op: `upsert`, path });
        }
      }
    }
  );
  return interpret(fsMachine).start();
};

function addOrCreate(object, key, value) {
  if (object[key] != undefined) object[key].push(value);
  else object[key] = [value];
}

async function processGit(
  remote,
  name,
  localPath,
  remoteId,
  { actions: { createNode }, createContentDigest }
) {
  let repository;
  try {
    repository = await Git.Clone.clone(remote, localPath, {
      fetchOpts: {
        callbacks: {
          certificateCheck: () => 0
        }
      }
    });
  } catch (e) {
    // If cloning fails because repo already exists, then pull changes
    repository = await Git.Repository.open(localPath);
    await repository.fetchAll();
    await repository.mergeBranches("master", "origin/master");
  }
  const firstCommitOnMaster = await repository.getMasterCommit();
  // Parse Remote data using git-url-parse
  const parsedRemote = GitUrlParse(remote);
  parsedRemote.git_suffix = false;
  parsedRemote.webLink = parsedRemote.toString("https");
  delete parsedRemote.git_suffix;
  // Create GitRemote Node
  await createNode(
    Object.assign(parsedRemote, {
      id: remoteId,
      sourceInstanceName: name,
      parent: null,
      children: [],
      internal: {
        type: `GitRemote`,
        content: JSON.stringify(parsedRemote),
        contentDigest: createContentDigest(parsedRemote)
      }
    })
  );
  // Walk commits in repository
  var history = firstCommitOnMaster.history(Git.Revwalk.SORT.TIME);
  const commits = await new Promise((resolve, reject) => {
    history.on("end", resolve);
    history.start();
  });
  let fileCommits = {};
  await Promise.all(
    commits.map(async commit => {
      // Create GitCommit node for each commit
      await createNode({
        id: commit.sha(),
        gitRemote___NODE: remoteId,
        author: {
          name: commit.author().name(),
          email: commit.author().email()
        },
        date: commit.date(),
        message: commit.message(),
        parent: null,
        children: [],
        internal: {
          type: `GitCommit`,
          contentDigest: createContentDigest(commit)
        }
      });
      const walker = (await commit.getTree()).walk();
      // Walk all files affected by commit
      const entries = await new Promise((resolve, reject) => {
        walker.on("end", resolve);
        walker.start();
      });
      entries.forEach(entry => {
        addOrCreate(fileCommits, entry.path(), commit.sha());
      });
    })
  );
  return fileCommits;
}

exports.sourceNodes = async (
  api,
  { name, remote, patterns = `**`, ignore }
) => {
  const localPath = path.join(
    process.cwd(),
    `.cache`,
    `caches`,
    `gatsby-source-git-plus`,
    name
  );

  const remoteId = api.createNodeId(`git-remote-${name}`);

  const fileCommits = await processGit(remote, name, localPath, remoteId, api);

  const fsMachine = createFSMachine(
    api,
    name,
    localPath,
    remoteId,
    fileCommits
  );

  api.emitter.on(`BOOTSTRAP_FINISHED`, () => {
    fsMachine.send(`BOOTSTRAP_FINISHED`);
  });

  const watcher = chokidar.watch(localPath, {
    ignored: [
      `**/*.un~`,
      `**/.DS_Store`,
      `**/.gitignore`,
      `**/.npmignore`,
      `**/.babelrc`,
      `**/yarn.lock`,
      `**/bower_components`,
      `**/node_modules`,
      `../**/dist/**`,
      ...(ignore || [])
    ]
  });

  watcher.on(`add`, path => {
    fsMachine.send({
      type: `CHOKIDAR_ADD`,
      pathType: `file`,
      path
    });
  });

  watcher.on(`change`, path => {
    fsMachine.send({
      type: `CHOKIDAR_CHANGE`,
      pathType: `file`,
      path
    });
  });

  watcher.on(`unlink`, path => {
    fsMachine.send({ type: `CHOKIDAR_UNLINK`, pathType: `file`, path });
  });

  watcher.on(`addDir`, path => {
    fsMachine.send({ type: `CHOKIDAR_ADD`, pathType: `directory`, path });
  });

  watcher.on(`unlinkDir`, path => {
    fsMachine.send({ type: `CHOKIDAR_UNLINK`, pathType: `directory`, path });
  });

  return new Promise((resolve, reject) => {
    watcher.on(`ready`, () => {
      fsMachine.send({ type: `CHOKIDAR_READY`, resolve, reject });
    });
  });
};

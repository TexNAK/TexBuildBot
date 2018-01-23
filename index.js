var Docker = require('dockerode');
var rimraf = require('rimraf');
var stream = require('stream');
var yaml = require('js-yaml');
var Git = require('nodegit');
var path = require('path');
var tmp = require('tmp');
var fs = require('fs');

const docker = new Docker();
const statusContext = 'continuous-integration/latex/';
const status = {
  pending: {
    state: 'pending',
    description: 'Typesetting is in progress'
  },
  success: {
    state: 'success',
    description: 'Typesetting finished'
  },
  error: {
    state: 'error',
    description: 'Typesetting failed'
  },
  failure: {
    state: 'failure',
    description: 'An internal error occurred'
  }
};

let robot;

function allComplete(promises) {
  "use strict";

  return new Promise(resolve => {
      let retVals = Array(promises.length).fill();
      let states = Array(promises.length).fill();

      let f = i => res => {
          retVals[i] = res;
          states[i] = true;
          if (states.every(s => s)) {
              resolve(retVals);
          }
      };

      promises.forEach((p, i) => {
          Promise.resolve(p).then(f(i), f(i));
      });
  });
}

async function runTypesettingContainer(srcDirectory, entrypoint) {
  const dockerOptions = {
    Tty: false,
    HostConfig: {
      Binds: [`${srcDirectory}:/data`],
      NetworkDisabled: true
    }
  }

  var logOutput = "";
  var logStream = new stream.PassThrough();
  logStream.on('data', function(chunk){
    logOutput += chunk.toString('utf8');
  });

  return new Promise((resolve, reject) => {
    docker.run('texbuildbot-typesetting', [entrypoint], [logStream, logStream], dockerOptions, function (err, data, container) {
      if (err)
        reject({
          message: 'Container launch failed',
          error: err
        });
      else {
        if (data.StatusCode === 0)
          resolve({
            message: 'Build succeeded',
            artifact: path.join(srcDirectory, entrypoint.replace('.tex', '.pdf')),
            log: logOutput
          });
        else
          reject({
            message: 'LaTeX build failed!',
            log: logOutput
          });

        container.remove(function (err, data) {
          if (err) console.error('Unable to delete container!', err);
        })
      }
    });
  });
}

async function runSpellcheckingContainer(srcDirectory) {
  const dockerOptions = {
    Tty: false,
    HostConfig: {
      Binds: [`${srcDirectory}:/data`]
    }
  }

  var logOutput = "";
  var logStream = new stream.PassThrough();
  logStream.on('data', function(chunk){
    logOutput += chunk.toString('utf8');
  });

  return new Promise((resolve, reject) => {
    docker.run('texbuildbot-spellchecking', [], [logStream, logStream], dockerOptions, function (err, data, container) {
      if (err)
        reject({
          message: 'Container launch failed',
          error: err
        });
      else {
        if (data.StatusCode === 0)
          resolve({
            message: 'Spellchecking succeeded',
            log: logOutput
          });
        else
          reject({
            message: 'Spellchecking failed!',
            log: logOutput
          });

        container.remove(function (err, data) {
          if (err) console.error('Unable to delete container!', err);
        })
      }
    });
  });
}

function setStatus(context, type, status, description) {
  const { ctx, owner, repo, sha } = context;

  ctx.github.repos.createStatus({
    owner: owner,
    repo: repo,
    sha: sha,
    state: status.state,
    description: typeof description === 'string' ? description : status.description,
    context: statusContext + type
  }).catch(function(err) {
    robot.log("Failed to set status!");
    robot.log(err);
  });
}

function executeBuild(context, srcDirectory, entrypoints) {

  const typesettingBuilds = [];

  robot.log("Building entrypoints", entrypoints);

  for (let entrypoint in entrypoints) {
    entrypoint = entrypoints[entrypoint];
    typesettingBuilds.push(runTypesettingContainer(srcDirectory, entrypoint));
  }

  const buildFailed = (err) => {
    robot.log("Build failed!", err);
    setStatus(context, 'typesetting', status.error);
    if (context.pr && context.config.spellchecking) setStatus(context, 'spellchecking', status.failure, 'No PDF artifact available');
  }

  allComplete(typesettingBuilds).then((results) => {
    setStatus(context, 'typesetting', status.success);

    const artifacts = [];
    for (let res in results) {
      if (results[res].artifact === undefined) {
        buildFailed(results[res]);
        return;
      }
      artifacts.push(results[res].artifact);
    }

    let spellcheckingFinished = false;
    let releasingFinished = false;

    const deleteTemporaryDirectory = () => {
      if (srcDirectory === '/') console.log("Nice try. I ain't deleting maself!");
      else rimraf(srcDirectory, (err) => {
        if (err) robot.log("Failed to delete temporary directory");
      });
    }

    /// Run the spellchecker and comment on the PR
    if (context.pr && context.config.spellchecking) {
      setStatus(context, 'spellchecking', status.pending, 'Spellchecking is in progress');
      runSpellcheckingContainer(srcDirectory).then((res) => {
        // Add res as a comment on the PR
        const commentData = {
          owner: context.owner,
          repo: context.repo,
          number: context.pr,
          body: res.log
        };
        context.ctx.github.issues.createComment(commentData, (err, result) => {
          spellcheckingFinished = true;
          if (!err)
            setStatus(context, 'spellchecking', status.success, 'Spellchecking successful');
          else
            setStatus(context, 'spellchecking', status.failure, 'Unable to post comment');

          if (releasingFinished) deleteTemporaryDirectory();
        });

      }).catch((err) => {
        spellcheckingFinished = true;
        setStatus(context, 'spellchecking', status.error, 'Spellchecking threw error');
        if (releasingFinished) deleteTemporaryDirectory();
      });
    } else {
      spellcheckingFinished = true;
    }

    /// Check if this branch is qualified for prereleases and release the artifacts
    if (context.branch === context.config.prerelease) {
      robot.log("Emitting pre-release with artifacts", artifacts);
      context.ctx.github.repos.createRelease({
        owner: context.owner,
        repo: context.repo,
        tag_name: `merge-${new Date().toISOString().replace(/:/g, '-')}`,
        target_commitish: context.sha,
        name: context.commitMessage,
        prerelease: true
      }).then((release) => {
        const uploadAssets = [];
        for (let artifact in artifacts) {
          const assetData = {
            id: release.data.id,
            owner: context.owner,
            repo: context.repo,
            url: release.data.upload_url,
            filePath: artifacts[artifact],
            name: path.basename(artifacts[artifact])
          };

          uploadAssets.push(context.ctx.github.repos.uploadAsset(assetData));
        }

        allComplete(uploadAssets).then(() => {
          releasingFinished = true;
          if (spellcheckingFinished) deleteTemporaryDirectory();
        });
      });
    } else {
      releasingFinished = true;
    }

    robot.log("Build succeeded");
    if (spellcheckingFinished && releasingFinished) deleteTemporaryDirectory();

  }).catch(buildFailed);
}

function loadConfig(directory) {
  let config = {
    spellchecking: false,
    statistics: false,
    prerelease: 'master',
    entrypoints: ['./main.tex'],
    dictionaryFile: undefined
  }

  const configPath = path.join(directory, '.texbuild.yml');
  if (fs.existsSync(configPath)) {
    try {
      var doc = yaml.safeLoad(fs.readFileSync(configPath, 'utf8'));
      config = Object.assign(config, doc);
    } catch (e) {
      console.log(e);
    }
  }

  console.log(config);

  return config;
}

function queueBuild(context, ref) {
  const tmpobj = tmp.dirSync({ unsafeCleanup: true });
  const cloneDir = fs.realpathSync(tmpobj.name);
  context.branch = ref.replace('refs/heads/', '');

  const { owner, repo, sha } = context;

  setStatus(context, 'typesetting', status.pending, 'Cloning repository');

  robot.log(`Cloning https://github.com/${owner}/${repo} into ${cloneDir}`);

  Git.Clone(`https://github.com/${owner}/${repo}`, cloneDir, { checkoutBranch: ref.replace('refs/heads/', '') }).then(function(repository) {
    robot.log(`Clone successful (https://github.com/${owner}/${repo})!`);
    context.config = loadConfig(cloneDir);

    repository.getCommit(context.sha).then((commit) => {
      context.commitMessage = commit.message();

      setStatus(context, 'typesetting', status.pending);
      if (context.pr && context.config.spellchecking) setStatus(context, 'spellchecking', status.pending, 'Awaiting PDF output');

      executeBuild(context, cloneDir, context.config.entrypoints);

    });

  }).catch(function (err) {
    robot.log("Failed to pull repository!");
    robot.log(err);

    setStatus(context, 'typesetting', status.failure);
    if (context.pr && context.config.spellchecking) setStatus(context, 'spellchecking', status.failure);
  });
}

function processPullRequest(ctx) {
  // TODO Ignore push which triggers PR sync
  const head = ctx.payload.pull_request.head;
  queueBuild({
    ctx: ctx,
    owner: head.repo.owner.login,
    repo: head.repo.name,
    sha: head.sha,
    pr: ctx.payload.pull_request.number
  }, head.ref, true);
}

module.exports = (r) => {

  robot = r;

  robot.on('push', ctx => {
      for (commit in ctx.payload.commits) {
        commit = ctx.payload.commits[commit];

        if (!commit.distinct) {
          robot.log(`Skipping non-distinct commit ${commit.id}`);
          continue;
        }

        robot.log(`Received commit (${commit.id})`);

        queueBuild({
          ctx: ctx,
          owner: ctx.payload.repository.owner.name,
          repo: ctx.payload.repository.name,
          sha: commit.id
        }, ctx.payload.ref);
      }
  });

  robot.on('pull_request.opened', ctx => {
      robot.log('PR opened!');
      processPullRequest(ctx);
  });

  robot.on('pull_request.synchronize', ctx => {
      robot.log('PR synchronized!');
      processPullRequest(ctx);
  });

}

var Docker = require('dockerode');
var stream = require('stream');
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

function executeBuild(context, srcDirectory, entrypoint) {
  /// Run typesetting
  runTypesettingContainer(srcDirectory, entrypoint).then((res) => {
    setStatus(context, 'typesetting', status.success);

    if (context.pr) {
      setStatus(context, 'spellchecking', status.pending, 'Spellchecking is in progress');
      /// Run spellchecking once typesetting finishes
      runSpellcheckingContainer(srcDirectory).then((res) => {
        // Add res as a comment on the PR
        const commentData = {
          owner: context.owner,
          repo: context.repo,
          number: context.pr,
          body: res.log
        };
        context.ctx.github.issues.createComment(commentData, (err, result) => {
          if (!err)
            setStatus(context, 'spellchecking', status.success, 'Spellchecking successful');
          else
            setStatus(context, 'spellchecking', status.failure, 'Unable to post comment');
        });

      }).catch((err) => {
        setStatus(context, 'spellchecking', status.error, 'Spellchecking threw error');
      });
    }

    // Release res.artifact to github as pre-release (only on master)
    if (context.branch === 'master') {
      robot.log("Emitting pre-release");
      context.ctx.github.repos.createRelease({
        owner: context.owner,
        repo: context.repo,
        tag_name: `merge-${new Date().toISOString().replace(/:/g, '-')}`,
        target_commitish: context.sha,
        name: context.commitMessage,
        prerelease: true
      }).then((release) => {
        const assetData = {
          id: release.data.id,
          owner: context.owner,
          repo: context.repo,
          url: release.data.upload_url,
          filePath: res.artifact,
          name: path.basename(res.artifact)
        };

        context.ctx.github.repos.uploadAsset(assetData);
      });

    }

    // TODO Remove temporary folder contents

  }).catch((err) => {
    robot.log("Build failed!", err);
    setStatus(context, 'typesetting', status.error);
    if (context.pr) setStatus(context, 'spellchecking', status.failure, 'No PDF artifact available');
  });
}

function queueBuild(context, ref) {
  const tmpobj = tmp.dirSync({ unsafeCleanup: true });
  const cloneDir = fs.realpathSync(tmpobj.name);
  context.branch = ref.replace('refs/heads/', '');

  const { owner, repo, sha } = context;

  setStatus(context, 'typesetting', status.pending, 'Cloning repository');
  if (context.pr) setStatus(context, 'spellchecking', status.pending, 'Cloning repository');

  robot.log(`Cloning https://github.com/${owner}/${repo} into ${cloneDir}`);

  Git.Clone(`https://github.com/${owner}/${repo}`, cloneDir, { checkoutBranch: ref.replace('refs/heads/', '') }).then(function(repository) {
    robot.log(`Clone successful (https://github.com/${owner}/${repo})!`);

    repository.getCommit(context.sha).then((commit) => {
      context.commitMessage = commit.message();

      setStatus(context, 'typesetting', status.pending);
      if (context.pr) setStatus(context, 'spellchecking', status.pending, 'Awaiting PDF output');

      executeBuild(context, cloneDir, './main.tex');

    });

  }).catch(function (err) {
    robot.log("Failed to pull repository!");
    robot.log(err);

    setStatus(context, 'typesetting', status.failure);
    if (context.pr) setStatus(context, 'spellchecking', status.failure);
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
      robot.log('Push received!');

      for (commit in ctx.payload.commits) {
        commit = ctx.payload.commits[commit];
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

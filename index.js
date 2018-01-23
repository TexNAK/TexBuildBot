var Git = require('nodegit');
var tmp = require('tmp');

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
  failure: {
    state: 'failure',
    description: 'Unable to start build'
  }
};

let robot;

function setStatus(context, owner, repo, sha, type, status, description) {
  context.github.repos.createStatus({
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

function queueBuild(context, owner, repo, sha, ref, pr = false) {
  var tmpobj = tmp.dirSync({ unsafeCleanup: true });

  setStatus(context, owner, repo, sha, 'typesetting', status.pending, 'Cloning repository');
  if (pr) setStatus(context, owner, repo, sha, 'spellchecking', status.pending, 'Cloning repository');

  robot.log(`Cloning https://github.com/${owner}/${repo} into ${tmpobj.name}`);

  Git.Clone(`https://github.com/${owner}/${repo}`, tmpobj.name, { checkoutBranch: ref.replace('refs/heads/', '') }).then(function(repository) {
    robot.log(`Clone successfull (https://github.com/${owner}/${repo})!`);
    setStatus(context, owner, repo, sha, 'typesetting', status.pending);
    if (pr) setStatus(context, owner, repo, sha, 'spellchecking', status.pending, 'Awaiting PDF output');

    // TODO Run typesetting
    // TODO Run spellchecking once typesetting finishes (only if this is a PR)
    // TODO Add a comment when spellchecking finished (only if this is a PR)
    // TODO Release to github releases as pre-release (only on master)

    // TODO Remove temporary folder contents

    setTimeout(function () {
      setStatus(context, owner, repo, sha, 'typesetting', status.success);
      if (pr) setStatus(context, owner, repo, sha, 'spellchecking', status.success, 'Spellchecking finished');
    }, 15000);

  }).catch(function (err) {
    robot.log("Failed to pull repository!");
    robot.log(err);

    setStatus(context, owner, repo, sha, 'typesetting', status.failure);
    if (pr) setStatus(context, owner, repo, sha, 'spellchecking', status.failure);
  });
}

function processPullRequest(context) {
  // TODO Ignore push which triggers PR sync
  const head = context.payload.pull_request.head;
  queueBuild(context, head.repo.owner.login, head.repo.name, head.sha, head.ref, true);
}

module.exports = (r) => {

  robot = r;

  robot.on('push', context => {
      robot.log('Push received!');

      for (commit in context.payload.commits) {
        commit = context.payload.commits[commit];
        robot.log(`Received commit (${commit.id})`);

        queueBuild(context,
          context.payload.repository.owner.name,
          context.payload.repository.name,
          commit.id,
          context.payload.ref
        );
      }
  });

  robot.on('pull_request.opened', context => {
      robot.log('PR opened!');
      processPullRequest(context);
  });

  robot.on('pull_request.synchronize', context => {
      robot.log('PR synchronized!');
      processPullRequest(context);
  });

}

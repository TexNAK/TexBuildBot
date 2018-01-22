const statusDescription = {
  pending: 'The LaTeX typesetting is in progress',
  success: 'The LaTeX typesetting finished'
};
const statusContext = 'continuous-integration/latex/';

let robot;

function queueTypeset(context, owner, repo, sha) {
  context.github.repos.createStatus({
    owner: owner,
    repo: repo,
    sha: sha,
    state: 'pending',
    description: statusDescription.pending,
    context: statusContext + 'typesetting'
  });

  setTimeout(() => {
    robot.log(`Typesetting finished (${owner}/${repo}:${sha})!`);
    context.github.repos.createStatus({
      owner: owner,
      repo: repo,
      sha: sha,
      state: 'success',
      description: statusDescription.success,
      context: statusContext + 'typesetting'
    });
  }, 30000);
}

function queueSpellchecking(context, owner, repo, sha) {
  context.github.repos.createStatus({
    owner: owner,
    repo: repo,
    sha: sha,
    state: 'pending',
    description: statusDescription.pending,
    context: statusContext + 'spellchecking'
  });

  setTimeout(() => {
    robot.log(`Spellchecking finished (${owner}/${repo}:${sha})!`);
    context.github.repos.createStatus({
      owner: owner,
      repo: repo,
      sha: sha,
      state: 'success',
      description: statusDescription.success,
      context: statusContext + 'spellchecking'
    });
  }, 10000);
}

function queueBuild(context, owner, repo, sha) {
  queueSpellchecking(context, owner, repo, sha);
  queueTypeset(context, owner, repo, sha);
}

function processPullRequest(context) {
  robot.log(context.payload);

  const head = context.payload.pull_request.head;
  // TODO Add flag that it is a PR and that we should comment on it.
  queueBuild(context, head.repo.owner.login, head.repo.name, head.sha);
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
          commit.id
        );
      }
  });

  robot.on('pull_request.opened', context => {
      robot.log('PR opened!');
      processPullRequest(context);
  });

  robot.on('pull_request.synchronized', context => {
      robot.log('PR synchronized!');
      processPullRequest(context);
  });

}

const { getInput, setFailed } = require('@actions/core');
const { Octokit } = require("@octokit/core");

const token = getInput('token', { required: true });
const octokit = new Octokit({ auth: token });

const workflowRunID = getInput('run_id', { required: true });
const remoteRepo = getInput('remote_repo', { required: true });
const releaseID = getInput('release_id', { required: true });

// log the inputs
console.log(`Workflow Run ID: ${workflowRunID}`);
console.log(`Remote Repo: ${remoteRepo}`);
console.log(`Release ID: ${releaseID}`);

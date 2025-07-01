const { getInput, setFailed } = require('@actions/core');
const { Octokit } = require("@octokit/core");

const token = getInput('token', { required: true });
const octokit = new Octokit({ auth: token });

const workflowRepo = getInput('workflow_repo', { required: true });
const workflowRunID = getInput('run_id', { required: true });
const releaseRepo = getInput('release_repo', { required: true });
const releaseID = getInput('release_id', { required: true });

// log the inputs
console.log(`Workflow Repo: ${workflowRepo}`);
console.log(`Workflow Run ID: ${workflowRunID}`);
console.log(`Release Repo: ${releaseRepo}`);
console.log(`Release ID: ${releaseID}`);

// const response = await octokit.request(`GET /repos/${owner}/${repo}`);

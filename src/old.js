const { getInput, setFailed, setOutput } = require('@actions/core');
const { Octokit } = require("@octokit/core");

const token = getInput('token', { required: true });
const octokit = new Octokit({ auth: token });

const repoInput = getInput('repository', { required: true });
const [owner, repo] = repoInput.split('/');

const tag = getInput('tag', { required: true });
var commit = getInput('commit', { required: false });

async function getDefaultBranch() {
    const response = await octokit.request(`GET /repos/${owner}/${repo}`);
    const branch = response.data.default_branch;
    return branch;
}

async function getLatestCommit(branch) {
    const response = await octokit.request(`GET /repos/${owner}/${repo}/commits/${branch}`);
    return response.data.sha;
}

async function updateTag(tag, commit) {
    try {
        const response = await octokit.request(`PATCH /repos/${owner}/${repo}/git/refs/tags/${tag}`, {
            force: true,
            sha: commit
        });
        return response;
    } catch (error) {
        console.error(`Error creating tag: ${error.message}`);
        throw error;
    }
}

async function createTag(tag, commit) {
    try {
        const response = await octokit.request(`POST /repos/${owner}/${repo}/git/refs`, {
            ref: `refs/tags/${tag}`,
            sha: commit,
        });
        return response;
    } catch (error) {
        console.error(`Error creating tag: ${error.message}`);
        throw error;
    }
}

async function main() {
    if (!commit) {
        console.log('No commit specified, fetching latest commit from default branch...');
        const branch = await getDefaultBranch();
        console.log(`Default branch: ${branch}`);
        commit = await getLatestCommit(branch);
        console.log(`Using commit: ${commit}`);
    }
    console.log(`Checking if tag ${tag} exists...`);
    try {
        const response = await octokit.request(`GET /repos/${owner}/${repo}/git/refs/tags/${tag}`);
        console.log(`Tag ${tag} already exists.`);
        if (response.data.object.sha === commit) {
            console.log(`Tag ${tag} already points to commit ${commit}. No action needed.`);
            setOutput('result', 'created');
            setOutput('message', `Tag ${tag} already exists and points to the same commit.`);
            setOutput('tag', tag);
            setOutput('commit', commit);
        } else {
    //           skip_update:
    // description: 'Whether to skip updating the tag if already exists (defailt is false)'
    // required: false
    // default: "false"
            skip_update = getInput('skip_update', { required: false }) === 'true';
            if (skip_update) {
                console.log(`Tag ${tag} exists but points to a different commit. Skipping update as per input.`);
                setOutput('result', 'skipped');
                setOutput('message', `Tag ${tag} exists but points to a different commit. Skipping update as per input.`);
                setOutput('tag', tag);
                setOutput('commit', response.data.object.sha);
                return;
            }
            console.log(`Updating tag ${tag} to point to commit ${commit}...`);
            const updateResponse = await updateTag(tag, commit);
            setOutput('result', 'updated');
            setOutput('message', `Tag ${tag} updated successfully to point to commit ${commit}.`);
            setOutput('tag', tag);
            setOutput('commit', commit);

        }
    } catch (error) {
        if (error.status === 404) {
            console.log(`Tag ${tag} does not exist. Creating a new tag...`);
            const createResponse = await createTag(tag, commit);
            setOutput('result', 'created');
            setOutput('message', `Tag ${tag} created successfully with commit ${commit}.`);
            setOutput('tag', tag);
            setOutput('commit', commit);
            
        } else {
            console.error(`Error checking tag: ${error.message}`);
            setFailed(`Failed to check or create tag: ${error.message}`);
            setOutput('result', 'failed');
            setOutput('message', `Failed to create tag ${tag}: ${error.message}.`);
            setOutput('tag', "");
            setOutput('commit', "");
            return;
        }
    }
}
main().catch(error => {
    console.error('Unhandled error in main:', error);
    setFailed(`Unhandled error: ${error.message}`);
});

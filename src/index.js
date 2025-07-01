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

async function gerReleaseArtifacts() {
    try {
        response = await octokit.request(`GET /repos/${workflowRepo}/actions/runs/{workflowRunID}/artifacts`, {
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
        const artifacts = response.data.artifacts;
        if (artifacts.length === 0) {
            console.log('No artifacts found for this workflow run.');
            return [];
        }
        console.log(`Found ${artifacts.length} artifacts for workflow run ${workflowRunID}.`);
        return artifacts.map(artifact => ({
            id: artifact.id,
            name: artifact.name,
            size: artifact.size_in_bytes,
            url: artifact.url,
            archive_url: artifact.archive_download_url
        }));
    }
    catch (error) {
        console.error(`Error fetching artifacts: ${error.message}`);
        throw error;
    }
}

async function main(){
    try {
        const artifacts = await gerReleaseArtifacts();
        if (artifacts.length === 0) {
            console.log('No artifacts to upload.');
            return;
        }

        for (const artifact of artifacts) {
            console.log(`Uploading artifact: ${artifact.name} (${artifact.size} bytes)`);
            // Here you would implement the logic to upload the artifact to the release
            // For example, using octokit.rest.repos.uploadReleaseAsset
            // await octokit.rest.repos.uploadReleaseAsset({
            //     owner: 'OWNER',
            //     repo: 'REPO',
            //     release_id: releaseID,
            //     name: artifact.name,
            //     data: fs.createReadStream(artifact.archive_url)
            // });
        }
    } catch (error) {
        setFailed(`Action failed with error: ${error.message}`);
    }
}

main().catch(error => {
    console.error('Unhandled error in main:', error);
    setFailed(`Unhandled error: ${error.message}`);
});

// await octokit.request('GET /repos/{owner}/{repo}/releases/{release_id}/assets', {
//   owner: 'OWNER',
//   repo: 'REPO',
//   release_id: 'RELEASE_ID',
//   headers: {
//     'X-GitHub-Api-Version': '2022-11-28'
//   }
// })

// const response = await octokit.request(`GET /repos/${owner}/${repo}`);

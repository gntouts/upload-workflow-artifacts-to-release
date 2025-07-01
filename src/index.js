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

async function gerWorkflowArtifacts() {
    try {
//         curl -X GET https://api.github.com/repos/$TARGET_REPO/actions/runs/$RUN_ID/artifacts \
        //   -H "Accept: application/vnd.github+json" \
        //   -H "Authorization: Bearer $GITHUB_TOKEN" \
        //   -H "X-GitHub-Api-Version: 2022-11-28"
        response = await octokit.request(`GET /repos/${workflowRepo}/actions/runs`, {
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
        const runs = response.data.workflow_runs;
        if (runs.length === 0) {
            console.log('No workflow runs found for this repository.');
            return [];
        }
        console.log(`Found ${runs.length} workflow runs for repository ${workflowRepo}.`);
        const runs_id = runs.map(run => run.id);
        console.log(`Workflow Run IDs: ${runs_id.join(', ')}`);

        response = await octokit.request(`GET /repos/${workflowRepo}/actions/runs/${workflowRunID}/artifacts`, {
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

async function downloadArtifact(artifact){
    // Download the artifact using its url and save it to a local file under /tmp/artifacts/
    // Ensure the directory exists
    const dir = '/tmp/artifacts';
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir, { recursive: true });
    }
    // Download the artifact
    console.log(`Downloading artifact: ${artifact.name} from ${artifact.url}`);
    const fs = require('fs');
    const https = require('https');
    const filePath = `/tmp/artifacts/${artifact.name}`;
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        https.get(artifact.archive_url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download artifact: ${response.statusCode}`));
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => resolve(filePath));
            });
        }).on('error', (err) => {
            fs.unlink(filePath, () => reject(err));
        });
    });
}

async function main(){
    try {
        const artifacts = await gerWorkflowArtifacts();
        if (artifacts.length === 0) {
            console.log('No artifacts to upload.');
            return;
        }

        for (const artifact of artifacts) {
            console.log(`Downloading artifact: ${artifact.name} (${artifact.size} bytes)`);
            const localPath = await downloadArtifact(artifact);
            console.log(`Artifact downloaded to: ${localPath}`);
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

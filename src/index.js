const { getInput, setFailed, info, warning, error } = require('@actions/core');
const { Octokit } = require("@octokit/core");
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

function main() {
    try {
        // Get inputs
        const token = getInput('token', { required: true });
        const workflowRepo = getInput('workflow_repo', { required: true });
        const workflowRunID = getInput('run_id', { required: true });
        const releaseRepo = getInput('release_repo', { required: true });
        const releaseID = getInput('release_id', { required: true });

        const octokit = new Octokit({ auth: token });
        info(`Processing workflow run ${workflowRunID} from ${workflowRepo} to release ${releaseID} in ${releaseRepo}`);

        // Get existing assets
        const [releaseOwner, releaseRepoName] = releaseRepo.split('/');
        let existingAssets = {};
        try {
            const assetsResponse = octokit.request('GET /repos/{owner}/{repo}/releases/{release_id}/assets', {
                owner: releaseOwner,
                repo: releaseRepoName,
                release_id: parseInt(releaseID)
            });
            assetsResponse.data.forEach(asset => {
                existingAssets[asset.name] = asset.id;
            });
        } catch (err) {
            warning(`Could not fetch existing assets: ${err.message}`);
        }

        // Get artifacts
        const artifactsResponse = octokit.request(`GET /repos/${workflowRepo}/actions/runs/${workflowRunID}/artifacts`);
        const artifacts = artifactsResponse.data.artifacts || [];

        if (artifacts.length === 0) {
            info('No artifacts found');
            return;
        }

        info(`Found ${artifacts.length} artifacts`);
        let totalProcessed = 0;

        // Process each artifact
        for (const artifact of artifacts) {
            try {
                const [owner, repo] = workflowRepo.split('/');
                const zipPath = `./temp_${artifact.name}.zip`;

                // Download artifact
                info(`Downloading ${artifact.name}`);
                const downloadResponse = octokit.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
                    owner, repo, artifact_id: artifact.id, archive_format: 'zip'
                });
                
                fs.writeFileSync(zipPath, Buffer.from(downloadResponse.data));

                // Extract files
                yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
                    if (err) throw err;
                    
                    zipfile.on('entry', (entry) => {
                        if (!/\/$/.test(entry.fileName)) {
                            const fileName = path.basename(entry.fileName);
                            const tempPath = `./temp_${fileName}`;
                            
                            zipfile.openReadStream(entry, (err, readStream) => {
                                if (err) throw err;
                                
                                const writeStream = fs.createWriteStream(tempPath);
                                readStream.pipe(writeStream);
                                
                                writeStream.on('close', () => {
                                    // Upload or update file
                                    try {
                                        const fileStats = fs.statSync(tempPath);
                                        const contentType = getContentType(tempPath);

                                        // Check if asset exists and delete it
                                        if (existingAssets[fileName]) {
                                            octokit.request('DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}', {
                                                owner: releaseOwner,
                                                repo: releaseRepoName,
                                                asset_id: existingAssets[fileName]
                                            });
                                            info(`Deleted existing ${fileName}`);
                                        }

                                        // Upload new/updated file
                                        octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
                                            owner: releaseOwner,
                                            repo: releaseRepoName,
                                            release_id: parseInt(releaseID),
                                            name: fileName,
                                            data: fs.createReadStream(tempPath),
                                            headers: { 'Content-Type': contentType, 'Content-Length': fileStats.size }
                                        });

                                        info(`Uploaded ${fileName}`);
                                        totalProcessed++;
                                        
                                        // Cleanup
                                        fs.unlinkSync(tempPath);
                                        
                                    } catch (uploadErr) {
                                        error(`Failed to upload ${fileName}: ${uploadErr.message}`);
                                    }
                                    
                                    zipfile.readEntry();
                                });
                            });
                        } else {
                            zipfile.readEntry();
                        }
                    });
                    
                    zipfile.on('end', () => {
                        fs.unlinkSync(zipPath);
                    });
                    
                    zipfile.readEntry();
                });

            } catch (artifactErr) {
                error(`Failed to process artifact ${artifact.name}: ${artifactErr.message}`);
            }
        }

        info(`Successfully processed ${totalProcessed} files`);

    } catch (err) {
        error(`Action failed: ${err.message}`);
        setFailed(err.message);
        process.exit(1);
    }
}

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
        '.txt': 'text/plain', '.json': 'application/json', '.xml': 'application/xml',
        '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
        '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
        '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
        '.exe': 'application/octet-stream', '.dll': 'application/octet-stream'
    };
    return types[ext] || 'application/octet-stream';
}

main();
const { getInput, setFailed, info, warning, error } = require('@actions/core');
const { Octokit } = require("@octokit/core");
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

async function main() {
    try {
        // Get and validate inputs
        const token = getInput('token', { required: true });
        const workflowRepo = getInput('workflow_repo', { required: true });
        const workflowRunID = getInput('run_id', { required: true });
        const releaseRepo = getInput('release_repo', { required: true });
        const releaseID = getInput('release_id', { required: true });

        validateInputs(workflowRepo, releaseRepo, workflowRunID, releaseID);

        const octokit = new Octokit({ auth: token });
        info(`Processing workflow run ${workflowRunID} from ${workflowRepo} to release ${releaseID} in ${releaseRepo}`);

        // Get existing release assets
        const existingAssets = await getReleaseAssets(octokit, releaseRepo, releaseID);
        
        // Get and process artifacts
        const artifacts = await getArtifacts(octokit, workflowRepo, workflowRunID);
        if (artifacts.length === 0) {
            info('No artifacts found');
            return;
        }

        info(`Found ${artifacts.length} artifacts`);
        let totalProcessed = 0;

        // Process each artifact
        for (const artifact of artifacts) {
            try {
                const files = await downloadAndExtractArtifact(octokit, workflowRepo, artifact);
                totalProcessed += await uploadFilesToRelease(octokit, releaseRepo, releaseID, files, artifact.name, existingAssets);
                cleanupFiles(files);
            } catch (artifactErr) {
                error(`Failed to process artifact ${artifact.name}: ${artifactErr.message}`);
            }
        }

        info(`Successfully processed ${totalProcessed} files`);
        
        if (totalProcessed === 0 && artifacts.length > 0) {
            throw new Error('No files were processed for the release');
        }

    } catch (err) {
        error(`Action failed: ${err.message}`);
        setFailed(err.message);
        process.exit(1);
    }
}

function validateInputs(workflowRepo, releaseRepo, workflowRunID, releaseID) {
    const repoPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
    if (!repoPattern.test(workflowRepo) || !repoPattern.test(releaseRepo)) {
        throw new Error('Invalid repo format. Expected: owner/repo');
    }
    if (!/^\d+$/.test(workflowRunID) || !/^\d+$/.test(releaseID)) {
        throw new Error('Run ID and Release ID must be numeric');
    }
}

async function getReleaseAssets(octokit, releaseRepo, releaseID) {
    const [owner, repo] = releaseRepo.split('/');
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/releases/{release_id}/assets', {
            owner, repo, release_id: parseInt(releaseID)
        });
        return new Map(response.data.map(asset => [asset.name, asset.id]));
    } catch (err) {
        warning(`Could not fetch existing assets: ${err.message}`);
        return new Map();
    }
}

async function getArtifacts(octokit, workflowRepo, workflowRunID) {
    const response = await octokit.request(`GET /repos/${workflowRepo}/actions/runs/${workflowRunID}/artifacts`);
    return response.data.artifacts || [];
}

async function downloadAndExtractArtifact(octokit, workflowRepo, artifact) {
    const [owner, repo] = workflowRepo.split('/');
    const sanitizedName = artifact.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const zipPath = `./temp_${sanitizedName}.zip`;

    // Download artifact
    info(`Downloading ${artifact.name}`);
    const downloadResponse = await octokit.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
        owner, repo, artifact_id: artifact.id, archive_format: 'zip'
    });
    
    fs.writeFileSync(zipPath, Buffer.from(downloadResponse.data));

    // Extract files
    const extractedFiles = await extractZipFiles(zipPath);
    fs.unlinkSync(zipPath); // Cleanup zip immediately
    
    return extractedFiles;
}

async function extractZipFiles(zipPath) {
    return new Promise((resolve, reject) => {
        const files = [];
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            
            zipfile.on('entry', (entry) => {
                if (!/\/$/.test(entry.fileName)) { // Not a directory
                    const sanitizedPath = entry.fileName.replace(/\.\./g, '').replace(/^\/+/, '');
                    const tempPath = `./temp_${Date.now()}_${path.basename(sanitizedPath)}`;
                    
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) return reject(err);
                        const writeStream = fs.createWriteStream(tempPath);
                        writeStream.on('close', () => {
                            files.push({ path: tempPath, name: path.basename(sanitizedPath) });
                            zipfile.readEntry();
                        });
                        readStream.pipe(writeStream);
                    });
                } else {
                    zipfile.readEntry();
                }
            });
            
            zipfile.on('end', () => resolve(files));
            zipfile.readEntry();
        });
    });
}

async function uploadFilesToRelease(octokit, releaseRepo, releaseID, files, artifactName, existingAssets) {
    const [owner, repo] = releaseRepo.split('/');
    let processedCount = 0;

    for (const file of files) {
        try {
            const fileName = files.length === 1 ? file.name : `${artifactName}_${file.name}`;
            
            // Check if asset already exists
            if (existingAssets.has(fileName)) {
                await updateExistingAsset(octokit, owner, repo, existingAssets.get(fileName), file.path, fileName);
                info(`Updated ${fileName}`);
            } else {
                await uploadNewAsset(octokit, owner, repo, releaseID, file.path, fileName);
                info(`Uploaded ${fileName}`);
            }
            
            processedCount++;
        } catch (uploadErr) {
            error(`Failed to process ${file.name}: ${uploadErr.message}`);
        }
    }

    return processedCount;
}

async function updateExistingAsset(octokit, owner, repo, assetId, filePath, fileName) {
    // Delete existing asset
    await octokit.request('DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}', {
        owner, repo, asset_id: assetId
    });
    
    // Upload new version (we need the release_id for this, so we'll get it from the existing asset)
    const assetResponse = await octokit.request('GET /repos/{owner}/{repo}/releases/assets/{asset_id}', {
        owner, repo, asset_id: assetId
    }).catch(() => null);
    
    if (assetResponse) {
        const releaseId = assetResponse.data.url.match(/releases\/(\d+)\//)[1];
        await uploadNewAsset(octokit, owner, repo, releaseId, filePath, fileName);
    } else {
        // Fallback: try to find release by listing all releases and finding the one with this asset
        throw new Error('Could not determine release ID for asset update');
    }
}

async function uploadNewAsset(octokit, owner, repo, releaseID, filePath, fileName) {
    const fileStats = fs.statSync(filePath);
    const contentType = getContentType(filePath);

    await octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
        owner, repo,
        release_id: parseInt(releaseID),
        name: fileName,
        data: fs.createReadStream(filePath),
        headers: { 
            'Content-Type': contentType, 
            'Content-Length': fileStats.size 
        }
    });
}

function cleanupFiles(files) {
    files.forEach(file => {
        try {
            fs.unlinkSync(file.path);
        } catch (err) {
            warning(`Could not cleanup file ${file.path}: ${err.message}`);
        }
    });
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

// Error handlers
process.on('unhandledRejection', (reason) => {
    error(`Unhandled rejection: ${reason}`);
    setFailed(`Unhandled rejection: ${reason}`);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    error(`Uncaught exception: ${err.message}`);
    setFailed(`Uncaught exception: ${err.message}`);
    process.exit(1);
});

main();
const { getInput, setFailed, info, warning, error } = require('@actions/core');
const { Octokit } = require("@octokit/core");
const fs = require('fs');
const https = require('https');
const path = require('path');

class GitHubActionError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'GitHubActionError';
        this.cause = cause;
    }
}

// Input validation and initialization
function validateInputs() {
    const inputs = {
        token: getInput('token', { required: true }),
        workflowRepo: getInput('workflow_repo', { required: true }),
        workflowRunID: getInput('run_id', { required: true }),
        releaseRepo: getInput('release_repo', { required: true }),
        releaseID: getInput('release_id', { required: true })
    };

    // Validate repo format (owner/repo)
    const repoPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
    if (!repoPattern.test(inputs.workflowRepo)) {
        throw new GitHubActionError(`Invalid workflow_repo format: ${inputs.workflowRepo}. Expected format: owner/repo`);
    }
    if (!repoPattern.test(inputs.releaseRepo)) {
        throw new GitHubActionError(`Invalid release_repo format: ${inputs.releaseRepo}. Expected format: owner/repo`);
    }

    // Validate IDs are numeric
    if (!/^\d+$/.test(inputs.workflowRunID)) {
        throw new GitHubActionError(`Invalid run_id: ${inputs.workflowRunID}. Must be a numeric ID`);
    }
    if (!/^\d+$/.test(inputs.releaseID)) {
        throw new GitHubActionError(`Invalid release_id: ${inputs.releaseID}. Must be a numeric ID`);
    }

    return inputs;
}

function initializeOctokit(token) {
    try {
        return new Octokit({ auth: token });
    } catch (err) {
        throw new GitHubActionError('Failed to initialize Octokit client', err);
    }
}

async function getWorkflowArtifacts(octokit, workflowRepo, workflowRunID) {
    try {
        info(`Fetching artifacts for workflow run ${workflowRunID} in repository ${workflowRepo}`);
        
        const response = await octokit.request(`GET /repos/${workflowRepo}/actions/runs/${workflowRunID}/artifacts`, {
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        const artifacts = response.data.artifacts;
        
        if (!artifacts || artifacts.length === 0) {
            warning('No artifacts found for this workflow run');
            return [];
        }

        info(`Found ${artifacts.length} artifacts for workflow run ${workflowRunID}`);
        
        return artifacts.map(artifact => {
            if (!artifact.id || !artifact.name || !artifact.archive_download_url) {
                warning(`Artifact missing required fields: ${JSON.stringify(artifact)}`);
                return null;
            }
            
            return {
                id: artifact.id,
                name: artifact.name,
                size: artifact.size_in_bytes || 0,
                url: artifact.url,
                archive_url: artifact.archive_download_url
            };
        }).filter(Boolean); // Remove null entries
        
    } catch (err) {
        if (err.status === 404) {
            throw new GitHubActionError(`Workflow run ${workflowRunID} not found in repository ${workflowRepo}`);
        } else if (err.status === 403) {
            throw new GitHubActionError('Access denied. Check if the token has sufficient permissions');
        } else if (err.status === 401) {
            throw new GitHubActionError('Authentication failed. Check if the token is valid');
        } else {
            throw new GitHubActionError(`Failed to fetch artifacts: ${err.message}`, err);
        }
    }
}

async function downloadArtifact(artifact, token, downloadDir = './archived-artifacts') {
    if (!artifact || !artifact.name || !artifact.archive_url) {
        throw new GitHubActionError('Invalid artifact object provided');
    }

    try {
        // Ensure the directory exists
        if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, { recursive: true });
            info(`Created download directory: ${downloadDir}`);
        }

        // Sanitize filename to prevent path traversal
        const sanitizedName = artifact.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const filePath = path.join(downloadDir, `${sanitizedName}.zip`);
        
        info(`Downloading artifact: ${artifact.name} (${artifact.size} bytes) to ${filePath}`);

        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(filePath);
            const timeoutMs = 300000; // 5 minutes timeout
            
            const cleanup = () => {
                if (file && !file.destroyed) {
                    file.destroy();
                }
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                    } catch (unlinkErr) {
                        warning(`Failed to cleanup incomplete download: ${unlinkErr.message}`);
                    }
                }
            };

            const timeout = setTimeout(() => {
                cleanup();
                reject(new GitHubActionError(`Download timeout after ${timeoutMs}ms for artifact: ${artifact.name}`));
            }, timeoutMs);

            const request = https.get(artifact.archive_url, {
                headers: {
                    'Accept': 'application/vnd.github+json',
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'GitHub-Action-Artifact-Downloader'
                },
                timeout: 30000 // Connection timeout
            }, (response) => {
                clearTimeout(timeout);
                
                if (response.statusCode === 302 || response.statusCode === 301) {
                    // Handle redirect
                    const redirectUrl = response.headers.location;
                    if (redirectUrl) {
                        response.destroy();
                        // Recursive call with redirect URL
                        downloadArtifact({ ...artifact, archive_url: redirectUrl }, token, downloadDir)
                            .then(resolve)
                            .catch(reject);
                        return;
                    }
                }
                
                if (response.statusCode !== 200) {
                    cleanup();
                    reject(new GitHubActionError(`Failed to download artifact ${artifact.name}: HTTP ${response.statusCode} ${response.statusMessage}`));
                    return;
                }

                let downloadedBytes = 0;
                response.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                });

                response.pipe(file);

                file.on('finish', () => {
                    file.close(() => {
                        info(`Successfully downloaded ${artifact.name}: ${downloadedBytes} bytes`);
                        resolve(filePath);
                    });
                });

                file.on('error', (err) => {
                    cleanup();
                    reject(new GitHubActionError(`File write error for ${artifact.name}: ${err.message}`, err));
                });
            });

            request.on('error', (err) => {
                clearTimeout(timeout);
                cleanup();
                reject(new GitHubActionError(`Network error downloading ${artifact.name}: ${err.message}`, err));
            });

            request.on('timeout', () => {
                clearTimeout(timeout);
                request.destroy();
                cleanup();
                reject(new GitHubActionError(`Connection timeout downloading ${artifact.name}`));
            });
        });

    } catch (err) {
        throw new GitHubActionError(`Failed to download artifact ${artifact.name}: ${err.message}`, err);
    }
}

async function uploadArtifactToRelease(octokit, releaseRepo, releaseID, filePath, artifactName) {
    try {
        const [owner, repo] = releaseRepo.split('/');
        const fileStats = fs.statSync(filePath);
        const fileStream = fs.createReadStream(filePath);

        info(`Uploading ${artifactName} to release ${releaseID} in ${releaseRepo}`);

        const response = await octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
            owner,
            repo,
            release_id: parseInt(releaseID),
            name: `${artifactName}.zip`,
            data: fileStream,
            headers: {
                'Content-Type': 'application/zip',
                'Content-Length': fileStats.size,
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        info(`Successfully uploaded ${artifactName} to release. Asset ID: ${response.data.id}`);
        return response.data;

    } catch (err) {
        if (err.status === 404) {
            throw new GitHubActionError(`Release ${releaseID} not found in repository ${releaseRepo}`);
        } else if (err.status === 422) {
            throw new GitHubActionError(`Asset upload failed - possibly duplicate name or invalid release: ${err.message}`);
        } else {
            throw new GitHubActionError(`Failed to upload ${artifactName} to release: ${err.message}`, err);
        }
    }
}

async function main() {
    let inputs;
    let octokit;

    try {
        // Validate inputs
        inputs = validateInputs();
        info(`Workflow Repo: ${inputs.workflowRepo}`);
        info(`Workflow Run ID: ${inputs.workflowRunID}`);
        info(`Release Repo: ${inputs.releaseRepo}`);
        info(`Release ID: ${inputs.releaseID}`);

        // Initialize Octokit
        octokit = initializeOctokit(inputs.token);

        // Get artifacts
        const artifacts = await getWorkflowArtifacts(octokit, inputs.workflowRepo, inputs.workflowRunID);
        
        if (artifacts.length === 0) {
            info('No artifacts to process. Exiting successfully.');
            return;
        }

        const downloadResults = [];
        const uploadResults = [];

        // Download artifacts with error handling for individual artifacts
        for (const artifact of artifacts) {
            try {
                const localPath = await downloadArtifact(artifact, inputs.token);
                downloadResults.push({ artifact, localPath, success: true });
            } catch (err) {
                error(`Failed to download artifact ${artifact.name}: ${err.message}`);
                downloadResults.push({ artifact, error: err, success: false });
                // Continue with other artifacts instead of failing completely
            }
        }

        // Upload successful downloads to release
        for (const result of downloadResults) {
            if (!result.success) continue;

            try {
                await uploadArtifactToRelease(
                    octokit,
                    inputs.releaseRepo,
                    inputs.releaseID,
                    result.localPath,
                    result.artifact.name
                );
                uploadResults.push({ artifact: result.artifact, success: true });
                
                // Clean up downloaded file after successful upload
                try {
                    fs.unlinkSync(result.localPath);
                    info(`Cleaned up temporary file: ${result.localPath}`);
                } catch (cleanupErr) {
                    warning(`Failed to cleanup file ${result.localPath}: ${cleanupErr.message}`);
                }
                
            } catch (err) {
                error(`Failed to upload artifact ${result.artifact.name}: ${err.message}`);
                uploadResults.push({ artifact: result.artifact, error: err, success: false });
            }
        }

        // Summary
        const successfulDownloads = downloadResults.filter(r => r.success).length;
        const successfulUploads = uploadResults.filter(r => r.success).length;
        
        info(`Summary: ${successfulDownloads}/${artifacts.length} downloads successful, ${successfulUploads}/${successfulDownloads} uploads successful`);

        // If no artifacts were successfully processed, fail the action
        if (successfulUploads === 0 && artifacts.length > 0) {
            throw new GitHubActionError('No artifacts were successfully uploaded to the release');
        }

    } catch (err) {
        const errorMessage = err instanceof GitHubActionError ? err.message : `Unexpected error: ${err.message}`;
        error(`Action failed: ${errorMessage}`);
        
        if (err.cause) {
            error(`Caused by: ${err.cause.message}`);
        }
        
        setFailed(errorMessage);
        process.exit(1);
    }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    error(`Unhandled promise rejection at: ${promise}, reason: ${reason}`);
    setFailed(`Unhandled promise rejection: ${reason}`);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    error(`Uncaught exception: ${err.message}`);
    setFailed(`Uncaught exception: ${err.message}`);
    process.exit(1);
});

// Run the main function
main().catch(err => {
    error(`Fatal error in main: ${err.message}`);
    setFailed(`Fatal error: ${err.message}`);
    process.exit(1);
});
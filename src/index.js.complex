const { getInput, setFailed, info, warning, error } = require('@actions/core');
const { Octokit } = require("@octokit/core");
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

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

async function downloadArtifact(octokit, workflowRepo, artifact, downloadDir = './archived-artifacts') {
    if (!artifact || !artifact.name || !artifact.id) {
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

        const [owner, repo] = workflowRepo.split('/');

        // Use Octokit to download the artifact
        const response = await octokit.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
            owner,
            repo,
            artifact_id: artifact.id,
            archive_format: 'zip',
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        // The response.data will be an ArrayBuffer containing the zip file
        const buffer = Buffer.from(response.data);

        // Write the buffer to file
        await fs.promises.writeFile(filePath, buffer);

        info(`Successfully downloaded ${artifact.name}: ${buffer.length} bytes`);
        return filePath;

    } catch (err) {
        // Clean up partial file if it exists
        const sanitizedName = artifact.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const filePath = path.join(downloadDir, `${sanitizedName}.zip`);

        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (unlinkErr) {
                warning(`Failed to cleanup incomplete download: ${unlinkErr.message}`);
            }
        }

        if (err.status === 404) {
            throw new GitHubActionError(`Artifact ${artifact.name} (ID: ${artifact.id}) not found or expired`);
        } else if (err.status === 403) {
            throw new GitHubActionError(`Access denied downloading artifact ${artifact.name}. Check token permissions`);
        } else if (err.status === 410) {
            throw new GitHubActionError(`Artifact ${artifact.name} has expired and is no longer available for download`);
        } else {
            throw new GitHubActionError(`Failed to download artifact ${artifact.name}: ${err.message}`, err);
        }
    }
}

async function extractArtifact(zipFilePath, extractDir) {
    const extractedFiles = [];

    try {
        info(`Extracting artifact: ${zipFilePath} to ${extractDir}`);

        // Ensure extraction directory exists
        if (!fs.existsSync(extractDir)) {
            fs.mkdirSync(extractDir, { recursive: true });
        }

        return new Promise((resolve, reject) => {
            yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
                if (err) {
                    reject(new GitHubActionError(`Failed to open zip file ${zipFilePath}: ${err.message}`, err));
                    return;
                }

                zipfile.readEntry();

                zipfile.on('entry', (entry) => {
                    // Sanitize entry filename to prevent path traversal
                    const sanitizedFileName = entry.fileName.replace(/\.\./g, '').replace(/^\/+/, '');
                    const outputPath = path.join(extractDir, sanitizedFileName);

                    // Ensure the output path is within the extraction directory
                    if (!outputPath.startsWith(extractDir)) {
                        warning(`Skipping potentially dangerous path: ${entry.fileName}`);
                        zipfile.readEntry();
                        return;
                    }

                    if (/\/$/.test(entry.fileName)) {
                        // Directory entry
                        if (!fs.existsSync(outputPath)) {
                            fs.mkdirSync(outputPath, { recursive: true });
                        }
                        zipfile.readEntry();
                    } else {
                        // File entry
                        // Ensure parent directory exists
                        const parentDir = path.dirname(outputPath);
                        if (!fs.existsSync(parentDir)) {
                            fs.mkdirSync(parentDir, { recursive: true });
                        }

                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(new GitHubActionError(`Failed to read entry ${entry.fileName}: ${err.message}`, err));
                                return;
                            }

                            const writeStream = fs.createWriteStream(outputPath);

                            writeStream.on('error', (err) => {
                                reject(new GitHubActionError(`Failed to write file ${outputPath}: ${err.message}`, err));
                            });

                            writeStream.on('close', () => {
                                extractedFiles.push({
                                    originalName: entry.fileName,
                                    extractedPath: outputPath,
                                    size: fs.statSync(outputPath).size
                                });
                                zipfile.readEntry();
                            });

                            readStream.pipe(writeStream);
                        });
                    }
                });

                zipfile.on('end', () => {
                    info(`Successfully extracted ${extractedFiles.length} files from ${zipFilePath}`);
                    resolve(extractedFiles);
                });

                zipfile.on('error', (err) => {
                    reject(new GitHubActionError(`Zip file processing error: ${err.message}`, err));
                });
            });
        });

    } catch (err) {
        throw new GitHubActionError(`Failed to extract artifact ${zipFilePath}: ${err.message}`, err);
    }
}

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.xml': 'application/xml',
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.zip': 'application/zip',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip',
        '.exe': 'application/octet-stream',
        '.dll': 'application/octet-stream',
        '.so': 'application/octet-stream',
        '.dylib': 'application/octet-stream'
    };
    return contentTypes[ext] || 'application/octet-stream';
}

async function uploadFileToRelease(octokit, releaseRepo, releaseID, filePath, fileName) {
    try {
        const [owner, repo] = releaseRepo.split('/');
        const fileStats = fs.statSync(filePath);
        const fileStream = fs.createReadStream(filePath);
        const contentType = getContentType(filePath);

        info(`Uploading ${fileName} (${fileStats.size} bytes) to release ${releaseID} in ${releaseRepo}`);

        const response = await octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
            owner,
            repo,
            release_id: parseInt(releaseID),
            name: fileName,
            data: fileStream,
            headers: {
                'Content-Type': contentType,
                'Content-Length': fileStats.size,
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        info(`Successfully uploaded ${fileName} to release. Asset ID: ${response.data.id}`);
        return response.data;

    } catch (err) {
        if (err.status === 404) {
            throw new GitHubActionError(`Release ${releaseID} not found in repository ${releaseRepo}`);
        } else if (err.status === 422) {
            if (err.message.includes('already_exists')) {
                warning(`Asset ${fileName} already exists in release, skipping upload`);
                return null; // Not an error, just skip
            }
            throw new GitHubActionError(`Asset upload failed - possibly invalid release: ${err.message}`);
        } else {
            throw new GitHubActionError(`Failed to upload ${fileName} to release: ${err.message}`, err);
        }
    }
}

async function cleanupFiles(filePaths) {
    for (const filePath of filePaths) {
        try {
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                if (stats.isDirectory()) {
                    fs.rmSync(filePath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(filePath);
                }
                info(`Cleaned up: ${filePath}`);
            }
        } catch (cleanupErr) {
            warning(`Failed to cleanup ${filePath}: ${cleanupErr.message}`);
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

        // Download and extract artifacts with error handling for individual artifacts
        for (const artifact of artifacts) {
            try {
                // Download the artifact using Octokit
                const zipPath = await downloadArtifact(octokit, inputs.workflowRepo, artifact);

                // Extract the artifact
                const extractDir = path.join('./extracted-artifacts', artifact.name);
                const extractedFiles = await extractArtifact(zipPath, extractDir);

                downloadResults.push({
                    artifact,
                    zipPath,
                    extractDir,
                    extractedFiles,
                    success: true
                });

                info(`Successfully processed artifact ${artifact.name}: ${extractedFiles.length} files extracted`);

            } catch (err) {
                error(`Failed to process artifact ${artifact.name}: ${err.message}`);
                downloadResults.push({ artifact, error: err, success: false });
                // Continue with other artifacts instead of failing completely
            }
        }

        // Upload extracted files to release
        for (const result of downloadResults) {
            if (!result.success) continue;

            let uploadedCount = 0;
            const filesToCleanup = [result.zipPath, result.extractDir];

            for (const extractedFile of result.extractedFiles) {
                try {
                    // Create a meaningful filename that includes the artifact name
                    const fileName = result.extractedFiles.length === 1
                        ? path.basename(extractedFile.extractedPath) // Single file: use original name
                        : `${result.artifact.name}_${path.basename(extractedFile.extractedPath)}`; // Multiple files: prefix with artifact name
                    console.log(`Preparing to upload file: ${fileName}`);
                    console.log(`Preparing to upload file: ${extractedFile}`);
                    const uploadResult = await uploadFileToRelease(
                        octokit,
                        inputs.releaseRepo,
                        inputs.releaseID,
                        extractedFile.extractedPath,
                        fileName
                    );

                    if (uploadResult) { // uploadResult is null if file already exists (not an error)
                        uploadedCount++;
                    }

                } catch (err) {
                    error(`Failed to upload file ${extractedFile.originalName} from artifact ${result.artifact.name}: ${err.message}`);
                }
            }

            uploadResults.push({
                artifact: result.artifact,
                uploadedCount,
                totalFiles: result.extractedFiles.length,
                success: uploadedCount > 0 || result.extractedFiles.length === 0
            });

            // Clean up downloaded zip and extracted files
            await cleanupFiles(filesToCleanup);
        }

        // Summary
        const successfulDownloads = downloadResults.filter(r => r.success).length;
        const successfulUploads = uploadResults.filter(r => r.success).length;
        const totalFilesUploaded = uploadResults.reduce((sum, r) => sum + (r.uploadedCount || 0), 0);

        info(`Summary: ${successfulDownloads}/${artifacts.length} artifacts processed successfully`);
        info(`${successfulUploads}/${successfulDownloads} artifacts had successful uploads`);
        info(`Total files uploaded to release: ${totalFilesUploaded}`);

        // If no files were successfully uploaded, fail the action
        if (totalFilesUploaded === 0 && artifacts.length > 0) {
            throw new GitHubActionError('No files were successfully uploaded to the release');
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
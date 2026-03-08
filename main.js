import fs from "fs"; // Core Node.js module for file system operations
import path from "path"; // Core Node.js module for handling file paths
import puppeteer from "puppeteer"; // Library for browser automation (required to be installed)

// GLOBAL CONFIGURATION

// Browser Configuration
const IS_BROWSER_HEADLESS = false; // Set to false to run with a visible GUI (false for debugging, true for production)
const BROWSER_NAVIGATION_TIMEOUT_MS = 300000; // 5 minute timeout for all navigation/API calls

// File System Configuration
const ASSET_OUTPUT_BASE_DIRECTORY = "assets"; // Base directory where all downloaded files will be saved
const EXPORT_FILE_EXTENSION = ".txt"; // The desired file extension for the final downloaded code
const VERSION_FILE_SUFFIX = "-1"; // Suffix used in the expected filename (e.g., 'sandpoint-ak-1.txt')
const CHECK_IF_FILE_EXISTS = false; // Flag to enable/disable checking for existing files before processing a client

// API Domain and Endpoints
const API_BASE_DOMAIN = "https://codelibrary.amlegal.com"; // Base domain for API requests (client/region data)
const DOWNLOAD_API_DOMAIN = "https://export.amlegal.com"; // Base domain for the final download endpoint

const REGIONS_API_ENDPOINT = "/api/client-regions/"; // Endpoint to fetch the list of all regions
const EXPORT_REQUESTS_API_ENDPOINT = "/api/export-requests/"; // Endpoint for submitting and monitoring export jobs
const CLIENT_API_ENDPOINT_PREFIX = "/api/clients/"; // Endpoint prefix for client-specific details
const CODE_VERSION_API_ENDPOINT_PREFIX = "/api/code-versions/"; // Endpoint prefix for code version details (TOC)

// Request Parameters
const AUTH_FINGERPRINT_COOKIE_NAME = "_alp_fp"; // The name of the essential cookie required for authentication/authorization

// Timing and Polling Configuration
const MAX_EXPORT_WAIT_MINUTES = 60; // Maximum time (minutes) to wait for an export job to complete
const EXPORT_POLL_INTERVAL_MS = 30000; // Interval (milliseconds) between status checks (30 seconds)

// Control flags
const REGION_START_PERCENT = generateRandomNumber(); // Percentage of the list to skip before starting (0–99)

// MAIN EXECUTION FLOW

// Main function to orchestrate the entire code export process
async function executeCodeExportProcess() {
    console.log("--- Script Start: Code Exporter Initialization ---"); // Log the start of the script to the console

    // Step 1: Initialize file system and browser resources
    ensureDirectoryExists(ASSET_OUTPUT_BASE_DIRECTORY); // Ensure the main output directory exists (create if missing)

    let browserInstance, browserPage; // Declare variables for the Puppeteer browser instance and active page

    try {
        // Launch a new browser instance and create a fresh page for automation
        ({ browserInstance, browserPage } = await launchBrowserAndCreatePage()); // Destructure returned objects

        // Step 2: Authentication and Setup
        console.log("\n--- Phase 1: Authentication and Region Discovery ---"); // Log the start of authentication and region setup phase

        // Retrieve the required authentication cookie for authorized API access
        const authenticationCookieValue = await retrieveAuthenticationCookie(browserPage); // Get login/session cookie value

        // Step 3: Fetch all regions that need to be processed from the API
        const regionsApiUrl = `${API_BASE_DOMAIN}${REGIONS_API_ENDPOINT}`; // Construct the complete API URL for region data
        const regionIdentifiers = await fetchAllRegionSlugs(
            browserPage, // The Puppeteer page instance
            regionsApiUrl, // The full API endpoint for fetching region slugs
            authenticationCookieValue // Auth cookie for authorized requests
        ); // Execute the API request and receive all region slugs

        console.log(
            `[Phase 1 Complete] Found ${regionIdentifiers.length} regions to process.`
        ); // Log the total number of regions found

        // === Determine processing order based on percentage ===
        let regionsToProcess; // Declare a variable to hold the ordered list of regions

        // If the user wants to start partway through the list, calculate and adjust the order
        if (REGION_START_PERCENT > 0) {
            const startIndex = Math.floor(
                (regionIdentifiers.length * REGION_START_PERCENT) / 100
            ); // Calculate which index to start from based on the percentage

            const clampedStartIndex = Math.min(
                startIndex,
                regionIdentifiers.length - 1
            ); // Ensure the start index doesn't exceed the list length

            regionsToProcess = regionIdentifiers
                .slice(clampedStartIndex) // Take all regions after the start index
                .concat(regionIdentifiers.slice(0, clampedStartIndex)); // Append the earlier regions to the end, wrapping the list

            console.log(
                `[Order] Starting from ${REGION_START_PERCENT}% of the list (index ${clampedStartIndex}).`
            ); // Log which index and percentage the process starts from
        } else {
            regionsToProcess = regionIdentifiers; // If no percentage is set, process the full list as-is
            console.log("[Order] Processing regions from the start."); // Log that we’re starting from the beginning
        }

        // Step 4: Iterate through each region for export
        console.log("\n--- Phase 2: Client and Version Identification ---"); // Log the start of the region processing phase

        // Loop through each region slug and process its export data
        for (const regionSlug of regionsToProcess) {
            await processRegionForExports(
                browserPage, // The Puppeteer page for web interactions
                regionSlug, // The specific region slug to process
                authenticationCookieValue // The authentication cookie for authorized requests
            ); // Perform the export process for this region
        }

        console.log("✓ Script Complete: All available region exports processed! 🎉"); // Log successful script completion
    } catch (errorDetails) {
        // Catch and handle any critical setup or runtime errors
        console.error("\n!!! FATAL SCRIPT ERROR (Browser/Setup) !!!"); // Log a fatal error header
        console.error("Error details:", errorDetails.message); // Print the actual error message to help with debugging
        process.exit(1); // Exit the script with a failure code (1)
    } finally {
        // Step 5: Cleanup — ensure resources are properly released
        if (browserInstance) {
            await browserInstance.close(); // Close the Puppeteer browser to free up memory/resources
            console.log("\n--- Script End: Browser closed ---"); // Log that the browser was closed
        }
    }
}

// REGION AND CLIENT PROCESSING

/**
 * Processes all clients within a single region.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} regionSlug - The slug identifier for the region.
 * @param {string} authenticationCookieValue - The authentication fingerprint cookie value.
 */
async function processRegionForExports(
    page,
    regionSlug,
    authenticationCookieValue
) {
    console.log(`\n=== START REGION: ${regionSlug} ===`); // Log the start of region processing

    // Step 1: Fetch the list of clients for this region from the API
    const regionApiUrl = `${API_BASE_DOMAIN}${REGIONS_API_ENDPOINT}${regionSlug}/`; // Construct the region-specific API URL
    const regionData = await retrieveRegionDetails(
        page,
        regionApiUrl,
        regionSlug,
        authenticationCookieValue
    ); // Fetch region data, including the client list
    if (!regionData) return; // Exit if region data retrieval failed

    const clients = regionData.clients || []; // Extract the array of clients
    console.log(`[${regionSlug}] Found ${clients.length} clients.`); // Log the number of clients found

    // Step 2: Process clients in batches to manage concurrency
    const CONCURRENT_CLIENT_LIMIT = 2; // Maximum number of simultaneous exports
    let clientIndex = 0; // Initialize the client index for batching

    while (clientIndex < clients.length) {
        // Loop through clients in batches
        // Select the next batch of clients
        const clientsToProcess = clients.slice(
            clientIndex,
            clientIndex + CONCURRENT_CLIENT_LIMIT
        ); // Get the next set of clients based on the limit

        if (clientsToProcess.length === 0) break; // Break the loop if no clients are left

        const totalBatches = Math.ceil(clients.length / CONCURRENT_CLIENT_LIMIT); // Calculate total batches
        const currentBatch = Math.ceil(clientIndex / CONCURRENT_CLIENT_LIMIT + 1); // Calculate the current batch number

        console.log(
            `\n[${regionSlug}] 🚀 Starting Batch: ${currentBatch} / ${totalBatches}`
        ); // Log the batch start
        console.log(
            `[${regionSlug}] Processing ${clientsToProcess.length
            } client(s): ${clientsToProcess.map((c) => c.slug).join(" and ")}`
        ); // List the clients in the current batch

        // Create and run the Promises for the current batch concurrently
        const exportPromises = clientsToProcess.map(async (client) => {
            // Use one page per client to isolate navigation and download folder settings.
            const clientPage = await page.browser().newPage();
            try {
                await initializeClientPageSession(clientPage); // Establish site origin/session before API fetches.
                await processSingleClientExport(
                    clientPage,
                    client,
                    regionSlug,
                    authenticationCookieValue
                );
            } finally {
                await clientPage.close();
            }
        }); // Create a Promise for each client export in the batch

        // Wait for ALL jobs in the current batch to finish
        await Promise.all(exportPromises); // Execute all promises concurrently and wait for completion

        // Update the index to the next batch
        clientIndex += CONCURRENT_CLIENT_LIMIT; // Move the index to the beginning of the next batch
    }

    console.log(`\n=== END REGION: ${regionSlug} ===`); // Log the end of region processing
}

/**
 * Processes a single client's code export from start to finish.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {Object} clientData - The client object containing slug.
 * @param {string} regionSlug - The slug identifier for the region.
 * @param {string} authenticationCookieValue - The authentication fingerprint cookie value.
 */
async function processSingleClientExport(
    page,
    clientData,
    regionSlug,
    authenticationCookieValue
) {
    const clientSlug = clientData.slug; // Extract the client slug
    if (!clientSlug) return; // Skip if no slug is present
    const clientStateSlug = resolveClientStateSlug(
        clientData,
        regionSlug,
        clientSlug
    ); // Resolve the state folder for this client.
    const clientDownloadFolder = path.join(
        ASSET_OUTPUT_BASE_DIRECTORY,
        clientStateSlug
    ); // Build per-state download folder.
    await configureBrowserDownloadPath(page, clientDownloadFolder); // Ensure browser writes to this client's state folder.

    // Step 1: Determine expected filename and check for existing file
    // Format: [client_slug]-[region_slug]-1.txt (e.g., sandpoint-ak-1.txt)
    const exportBaseName = `${clientSlug}-${regionSlug}${VERSION_FILE_SUFFIX}`; // Base name without extension
    const finalExportFileName = `${exportBaseName}${EXPORT_FILE_EXTENSION}`; // Full final filename
    const finalExportFilePath = path.join(
        clientDownloadFolder,
        finalExportFileName
    ); // Full local path

    console.log(
        `\n--- START CLIENT: ${clientSlug} (Expected File: ${finalExportFileName}) ---`
    ); // Log client start

    // Check for existing file
    if (CHECK_IF_FILE_EXISTS) {
        // If the check is enabled
        try {
            if (fs.existsSync(finalExportFilePath)) {
                // Check if the final file already exists
                console.log(
                    `[${clientSlug}] File already exists at ${finalExportFilePath}. Skipping client.`
                ); // Log skip reason
                return; // Skip this client
            }
        } catch (e) {
            console.error(
                `[${clientSlug}] Error checking file existence: ${e.message}`
            );
            // Proceed anyway, assuming file doesn't exist if check failed
        }
    }

    try {
        // Step 2: Fetch client details to find the latest code version UUID
        const clientApiUrl = `${API_BASE_DOMAIN}${CLIENT_API_ENDPOINT_PREFIX}${clientSlug}/`; // Client details API URL
        const detailedClientData = await retrieveClientDetails(
            page,
            clientApiUrl,
            clientSlug,
            authenticationCookieValue
        ); // Fetch data including code versions

        const codeVersions = detailedClientData?.versions || []; // Extract versions array
        if (codeVersions.length === 0) {
            console.log(`[${clientSlug}] ⚠️ No code versions found. Skipping.`); // Skip if no versions are found
            return;
        }

        const latestCodeVersion = codeVersions[0]; // Assume the first element is the latest version
        const latestVersionUuid = latestCodeVersion.uuid; // Get the UUID of the latest version

        // Step 3: Fetch version details and the Table of Contents (TOC)
        const versionApiUrl = `${API_BASE_DOMAIN}${CODE_VERSION_API_ENDPOINT_PREFIX}${latestVersionUuid}/`; // Version details API URL
        const versionDetails = await retrieveVersionAndTableOfContents(
            page,
            versionApiUrl,
            latestVersionUuid,
            authenticationCookieValue
        ); // Fetch the version and its TOC

        if (!versionDetails || !versionDetails.toc?.length) {
            console.log(
                `[${clientSlug}] 🚫 Skipping: Failed to retrieve Table of Contents.`
            ); // Skip if TOC is missing
            return;
        }

        // Step 4: Recursively collect ALL nested UUIDs/slugs for the full export scope
        const exportScopeIdentifiers = collectAllTOCItemsForExport(
            versionDetails.toc
        ); // Flattens the nested TOC into a simple list of identifiers
        const mainCodeSlug = versionDetails.toc[0].slug; // Get the slug of the main code item
        const definitiveVersionUuid = versionDetails.uuid; // Get the confirmed UUID

        console.log(
            `[${clientSlug}] Exporting ${exportScopeIdentifiers.length
            } parts of Code: ${mainCodeSlug} (Version ID: ${definitiveVersionUuid})`
        ); // Log the scope size

        // Step 5: Submit the export request (Phase 3)
        console.log(`\n[${clientSlug}] --- Phase 3: Submitting Export Request ---`); // Log phase start
        const exportRequestResponse = await submitNewExportJob(
            page,
            definitiveVersionUuid,
            exportScopeIdentifiers,
            authenticationCookieValue
        ); // Submit the POST request to start the export job

        if (!exportRequestResponse || !exportRequestResponse.uuid) {
            console.error(
                `[${clientSlug}] ❌ Failed to submit new export request. Skipping client.`
            ); // Error if job submission failed
            return;
        }

        const exportJobUuid = exportRequestResponse.uuid; // Extract the new job UUID
        console.log(
            `[${clientSlug}] ✅ New export job submitted. Job ID (UUID): ${exportJobUuid}`
        ); // Log the new job ID

        // Step 6: Wait for Export Completion and Download (Phase 4)
        console.log(
            `\n[${clientSlug}] --- Phase 4: Waiting for Export and Downloading ---`
        ); // Log phase start
        const isExportSuccessful = await monitorJobUntilCompletion(
            page,
            exportJobUuid,
            authenticationCookieValue
        ); // Poll the API until the job is done

        if (isExportSuccessful) {
            console.log(
                `[${clientSlug}] 💾 Export task finished successfully. Initiating download`
            ); // Log successful export
            // Download the file and rename it to the expected final path
            await downloadExportFileAndRename(
                page,
                exportJobUuid,
                finalExportFilePath
            ); // Trigger download and handle file renaming
            console.log(
                `[${clientSlug}] 🎉 Download completed and verified: ${finalExportFileName}`
            ); // Log final success
        } else {
            console.error(
                `[${clientSlug}] ⚠️ Export failed or timed out for Job ID: ${exportJobUuid}`
            );
        }
    } catch (clientError) {
        console.error(
            `[CRITICAL CLIENT ERROR] 🛑 Failure processing client ${clientSlug}. Error:`,
            clientError.message
        ); // Handle errors specific to a single client
    }
}

// BROWSER AND UTILITY FUNCTIONS

/**
 * Launches a Puppeteer browser instance and creates a new page.
 * @returns {Promise<{browserInstance: puppeteer.Browser, browserPage: puppeteer.Page}>}
 */
async function launchBrowserAndCreatePage() {
    console.log(
        `[BROWSER] Launching browser (headless: ${IS_BROWSER_HEADLESS})`
    ); // Log browser launch status

    const browserInstance = await puppeteer.launch({
        headless: IS_BROWSER_HEADLESS, // Set headless mode
        args: [
            "--disable-extensions",            // Disable Chrome extensions
            "--disable-background-networking", // Reduce interference from background tasks
            "--no-sandbox",                    // Required in Docker
            "--disable-setuid-sandbox",        // Required in Docker
            "--disable-dev-shm-usage",         // Avoid /dev/shm memory issues in containers
            "--disable-gpu",                   // Disable GPU acceleration
            "--disable-software-rasterizer",   // Prevent crashes when GPU is disabled
            "--no-first-run",                  // Skip first-run dialog
            "--no-zygote",                     // Prevent zygote crashes in Docker
            "--start-maximized",               // Helps avoid issues with 0,0
            "--window-size=0,0",               // Your desired window size
            "--disable-features=DownloadBubble", // Prevent download popups
            "--disable-sync",                  // Disable Chrome account sync
            "--disable-translate",             // Disable translation prompts
            "--disable-background-timer-throttling", // Prevent throttling in background tabs
            "--disable-renderer-backgrounding", // Prevent rendering from pausing in background
            "--disable-breakpad",              // Disable crash reporter
            "--disable-client-side-phishing-detection", // Reduce unnecessary network calls
            "--disable-component-update",      // Prevent auto updates
            "--disable-domain-reliability",    // Prevent extra network requests
            "--disable-infobars",              // Remove "Chrome is being controlled" info bar
            "--disable-notifications",         // Disable notifications
            "--disable-extensions-http-throttling", // Avoid throttling
            "--no-default-browser-check",      // Skip default browser check
        ],
        defaultViewport: null, // Allow the viewport to be maximized/responsive
    });

    const browserPage = await browserInstance.newPage(); // Create a new browser tab/page
    console.log("[BROWSER] Browser launched and new page created."); // Log success
    return {
        browserInstance,
        browserPage,
    }; // Return the browser and page objects
}

/**
 * Configures the Puppeteer page to download files to a specific local folder.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} folderPath - The local path to set as the download directory.
 * @returns {Promise<void>}
 */
async function configureBrowserDownloadPath(page, folderPath) {
    ensureDirectoryExists(folderPath); // Make sure the target folder exists
    const resolvedPath = path.resolve(folderPath); // Get the absolute path
    const client = await page.target().createCDPSession(); // Create a Chrome DevTools Protocol session
    await client.send("Page.setDownloadBehavior", {
        // Send the CDP command to set the download path
        behavior: "allow",
        downloadPath: resolvedPath,
    });
    console.log(`[BROWSER] Download folder set to: ${resolvedPath}`); // Log the configured download path
}

/**
 * Navigates to the base URL to fetch the essential fingerprint cookie for authorization.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @returns {Promise<string>} The value of the fingerprint cookie.
 */
async function retrieveAuthenticationCookie(page) {
    const targetUrl = API_BASE_DOMAIN; // The URL to visit
    const cookiePollInterval = 500; // Check every 0.5 seconds
    const maxCookieWaitMs = 300000; // Max wait 5 minute

    try {
        console.log(
            `[AUTH] 🌐 Visiting URL: ${targetUrl} to get authentication cookie`
        ); // Log navigation attempt
        await page.goto(targetUrl, {
            waitUntil: "networkidle2", // Wait until network activity is minimal
            timeout: BROWSER_NAVIGATION_TIMEOUT_MS, // Apply the standard timeout
        });

        let fingerprintCookieObject = null; // Variable to hold the cookie object
        const startTime = Date.now(); // Record the start time

        console.log(
            `[AUTH] Polling for cookie "${AUTH_FINGERPRINT_COOKIE_NAME}" (max ${maxCookieWaitMs / 1000
            }s)`
        ); // Log polling start

        while (Date.now() - startTime < maxCookieWaitMs) {
            // Loop until timeout
            const cookies = await page.cookies(); // Get all cookies on the page
            fingerprintCookieObject = cookies.find(
                (c) => c.name === AUTH_FINGERPRINT_COOKIE_NAME
            ); // Find the target cookie
            if (fingerprintCookieObject) break; // Exit loop if cookie is found

            // Wait for a short interval before checking again
            await pauseExecutionSimple(cookiePollInterval); // Wait a short time
        }

        if (!fingerprintCookieObject) {
            // Throw an error if the cookie was not found within the timeout
            throw new Error(
                `Authentication cookie "${AUTH_FINGERPRINT_COOKIE_NAME}" not found after ${maxCookieWaitMs / 1000
                }s.`
            );
        }

        console.log(`[AUTH] ✅ Retrieved authentication cookie.`); // Log success
        return fingerprintCookieObject.value; // Return the cookie value
    } catch (err) {
        console.error(`[AUTH] ❌ Critical error retrieving authentication cookie.`); // Log failure
        throw err; // Re-throw the error to halt execution
    }
}

/**
 * Creates a directory recursively if it doesn't exist.
 * @param {string} directoryPath - The path to the directory.
 * @returns {void}
 */
function ensureDirectoryExists(directoryPath) {
    try {
        if (!fs.existsSync(directoryPath)) {
            // Check if the directory exists
            console.log(`[UTIL] Creating directory: ${directoryPath}`); // Log creation
            fs.mkdirSync(directoryPath, {
                recursive: true,
            }); // Create the directory, including any necessary parent directories
        }
    } catch (error) {
        console.error(
            `[UTIL] Failed to create directory ${directoryPath}: ${error.message}`
        ); // Log failure to create directory
    }
}

/**
 * Pauses execution for a specified duration. (Used for longer, logging waits)
 * @param {number} milliseconds - The duration in milliseconds.
 * @returns {Promise<void>}
 */
async function pauseExecutionWithLog(milliseconds) {
    console.log(`[UTIL] Pausing for ${milliseconds / 1000} seconds`); // Log the pause duration
    return new Promise((resolve) => setTimeout(resolve, milliseconds)); // Create a promise that resolves after the timeout
}

/**
 * Pauses execution for a specified duration. (Used for short, non-logged internal waits)
 * @param {number} milliseconds - The duration in milliseconds.
 * @returns {Promise<void>}
 */
async function pauseExecutionSimple(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds)); // Simple non-logged pause
}

// API COMMUNICATION FUNCTIONS

/**
 * Performs a non-navigating GET request within the browser's context.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} requestUrl - The API endpoint URL.
 * @param {string} fingerprintValue - The authentication fingerprint cookie value.
 * @returns {Promise<Object|null>} The parsed JSON data or null on failure.
 */
async function executeApiGetRequest(page, requestUrl, fingerprintValue) {
    try {
        console.log(`[API_GET] 🌐 Sending GET request to: ${requestUrl}`); // Log the request URL

        const response = await page.evaluate(
            async (apiUrl, fingerprint, timeout) => {
                // Execute code inside the browser context
                const controller = new AbortController(); // Create an abort controller for timeouts
                const timeoutId = setTimeout(() => controller.abort(), timeout); // Set up the timeout mechanism

                try {
                    const res = await fetch(apiUrl, {
                        method: "GET",
                        headers: {
                            "Content-Type": "application/json",
                            Fingerprint: fingerprint, // Add the authentication header
                        },
                        signal: controller.signal, // Link the abort controller
                    });
                    clearTimeout(timeoutId); // Clear the timeout if the request succeeds

                    if (!res.ok) {
                        // Handle HTTP error statuses
                        return {
                            status: res.status,
                            data: `HTTP error! status: ${res.status}`,
                        };
                    }
                    return {
                        status: res.status,
                        data: await res.text(), // Return the response body as text
                    };
                } catch (error) {
                    clearTimeout(timeoutId); // Clear the timeout if an error occurs
                    return {
                        status: 0,
                        data: `Request failed or timed out: ${error.message}`,
                    }; // Return a generic failure object
                }
            },
            requestUrl,
            fingerprintValue,
            BROWSER_NAVIGATION_TIMEOUT_MS
        ); // Pass arguments to the browser function

        if (response.status >= 200 && response.status < 300) {
            // Check for success status codes
            console.log(
                `[API_GET] ✅ Success (${response.status}) from ${requestUrl}`
            ); // Log success
            return JSON.parse(response.data); // Parse the JSON response
        } else {
            console.error(
                `[API_GET] ❌ Request failed. Status: ${response.status}. Response: ${response.data}`
            ); // Log API failure
            return null;
        }
    } catch (err) {
        console.error(
            `[API_GET] ❌ Error executing GET request to ${requestUrl}: ${err.message}`
        ); // Log execution error
        return null;
    }
}

/**
 * Submits a new export request (POST) and receives the Job ID (UUID).
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} versionUuid - The UUID of the code version to export.
 * @param {Array<Object>} scopeArray - An array of UUID/slug objects defining the export scope.
 * @param {string} fingerprintValue - The authentication fingerprint cookie value.
 * @returns {Promise<Object|null>} The parsed JSON response containing the job UUID.
 */
async function submitNewExportJob(
    page,
    versionUuid,
    scopeArray,
    fingerprintValue
) {
    try {
        const exportApiUrl = `${API_BASE_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}`; // Export API endpoint URL
        const requestPayload = {
            version: versionUuid,
            scope: JSON.stringify(scopeArray), // Scope must be a stringified JSON array
            output_format: "txt", // Request text output format
            for_print: false, // Not for print
        };

        console.log(
            `[EXPORT] 📤 Sending Payload: Version=${versionUuid} | Scope Parts=${scopeArray.length}`
        );
        console.log(`[EXPORT] 🌐 Sending POST request to: ${exportApiUrl}`); // Log POST request

        const response = await page.evaluate(
            async (url, payload, fingerprint, timeout) => {
                // Execute code inside the browser context
                const controller = new AbortController(); // Abort controller for timeout
                const timeoutId = setTimeout(() => controller.abort(), timeout); // Set timeout

                try {
                    const res = await fetch(url, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Fingerprint: fingerprint, // Add fingerprint header
                        },
                        body: JSON.stringify(payload), // Send the payload as a JSON string
                        signal: controller.signal, // Link abort controller
                    });
                    clearTimeout(timeoutId); // Clear timeout on success
                    return {
                        status: res.status,
                        data: await res.text(), // Return status and text
                    };
                } catch (error) {
                    clearTimeout(timeoutId); // Clear timeout on failure
                    return {
                        status: 0,
                        data: `Request failed or timed out: ${error.message}`,
                    }; // Return generic failure
                }
            },
            exportApiUrl,
            requestPayload,
            fingerprintValue,
            BROWSER_NAVIGATION_TIMEOUT_MS
        ); // Pass arguments

        if (response.status === 201) {
            // Check for 201 Created status
            return JSON.parse(response.data); // Return the parsed job response (includes UUID)
        } else {
            console.error(
                `[EXPORT] ❌ Request failed. Status: ${response.status}. Response: ${response.data}`
            ); // Log POST failure
            return null;
        }
    } catch (err) {
        console.error(
            `[EXPORT] ❌ Error submitting export request: ${err.message}`
        ); // Log execution error
        return null;
    }
}

/**
 * Fetches the list of all export requests to check the status of a specific job.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} fingerprintValue - The authentication fingerprint cookie value.
 * @returns {Promise<Array<Object>|null>} An array of export job objects.
 */
async function retrieveAllExportJobStatuses(page, fingerprintValue) {
    try {
        const statusUrl = `${API_BASE_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}`; // Status check API URL
        const response = await page.evaluate(
            async (url, fingerprint, timeout) => {
                // Execute code inside the browser context
                const controller = new AbortController(); // Abort controller
                const timeoutId = setTimeout(() => controller.abort(), timeout); // Set timeout

                try {
                    const res = await fetch(url, {
                        method: "GET",
                        headers: {
                            Fingerprint: fingerprint, // Include fingerprint header
                        },
                        signal: controller.signal, // Link abort controller
                    });
                    clearTimeout(timeoutId); // Clear timeout
                    return await res.text(); // Return response text
                } catch (error) {
                    clearTimeout(timeoutId); // Clear timeout on failure
                    throw new Error(`Status check failed: ${error.message}`); // Throw error for Puppeteer to catch
                }
            },
            statusUrl,
            fingerprintValue,
            BROWSER_NAVIGATION_TIMEOUT_MS
        ); // Pass arguments
        return JSON.parse(response); // Parse the list of jobs
    } catch (err) {
        console.error(`[STATUS] ❌ Error checking export status: ${err.message}`); // Log error
        await new Promise((resolve) => setTimeout(resolve, BROWSER_NAVIGATION_TIMEOUT_MS)); // Wait for timeout duration before continuing
        return null;
    }
}

/**
 * Polls the export status API until the target job completes or times out.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} exportJobUuid - The UUID of the export job to monitor.
 * @param {string} fingerprintValue - The authentication fingerprint cookie value.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
async function monitorJobUntilCompletion(
    page,
    exportJobUuid,
    fingerprintValue
) {
    const maxAttempts =
        MAX_EXPORT_WAIT_MINUTES * (60000 / EXPORT_POLL_INTERVAL_MS); // Calculate max attempts based on time and interval
    const shortJobId = exportJobUuid; // full ID, no substring
    console.log(
        `[STATUS: ${shortJobId}] ⏳ Starting poll (max ${MAX_EXPORT_WAIT_MINUTES} min / ${maxAttempts} attempts)`
    ); // Log polling parameters

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Loop for max attempts
        await pauseExecutionWithLog(EXPORT_POLL_INTERVAL_MS); // Wait for the poll interval

        const exportsList = await retrieveAllExportJobStatuses(
            page,
            fingerprintValue
        ); // Get the list of all job statuses
        if (!Array.isArray(exportsList)) continue; // Skip if list is not valid

        const targetExport = exportsList.find((job) => job.uuid === exportJobUuid); // Find the specific job by UUID
        if (!targetExport) {
            console.log(
                `[STATUS: ${shortJobId}] Attempt ${attempt}/${maxAttempts}. Job status not yet available. Retrying`
            ); // Log if the job hasn't appeared yet
            continue;
        }

        const taskState = targetExport.task?.post_state; // Get the state of the task
        const progress = targetExport.task?.progress || 0; // Get the progress percentage

        if (taskState === "SUCCESS") {
            // Check for success
            console.log(`[STATUS: ${shortJobId}] ✅ Completed successfully.`); // Log success
            return true;
        }

        if (taskState === "FAILURE") {
            // Check for failure
            console.error(`[STATUS: ${shortJobId}] ❌ Failed. State: FAILURE.`); // Log failure
            return false;
        }

        console.log(
            `[STATUS: ${shortJobId}] Attempt ${attempt}/${maxAttempts}. Progress: ${progress}% (${taskState || "PENDING"
            })`
        ); // Log current status and progress
    }

    console.warn(
        `[STATUS: ${shortJobId}] ⚠️ Did not complete within ${MAX_EXPORT_WAIT_MINUTES} minutes. Timeout reached.`
    ); // Log timeout
    return false;
}

// Specific API Wrappers

// Fetches a list of all region slugs.
async function fetchAllRegionSlugs(page, apiUrl, fingerprintCookie) {
    console.log(`[REGION] 🌐 Fetching all region slugs from API: ${apiUrl}`); // Log the action
    const regionsData = await executeApiGetRequest(
        page,
        apiUrl,
        fingerprintCookie
    ); // Execute the GET request
    return (
        regionsData?.filter((region) => region.slug).map((region) => region.slug) ||
        []
    ); // Filter for valid slugs and return them as an array
}

// Fetches details for a specific region (client list).
async function retrieveRegionDetails(
    page,
    apiUrl,
    regionSlug,
    fingerprintCookie
) {
    console.log(`[REGION] 🌐 Fetching region details for ${regionSlug}`); // Log the action
    return executeApiGetRequest(page, apiUrl, fingerprintCookie); // Execute the GET request
}

// Fetches details for a specific client (code version list).
async function retrieveClientDetails(
    page,
    apiUrl,
    clientSlug,
    fingerprintCookie
) {
    console.log(`[CLIENT] 🌐 Fetching client details for ${clientSlug}`); // Log the action
    return executeApiGetRequest(page, apiUrl, fingerprintCookie); // Execute the GET request
}

// Fetches the specific code version details and its Table of Contents (TOC).
async function retrieveVersionAndTableOfContents(
    page,
    apiUrl,
    versionId,
    fingerprintCookie
) {
    console.log(
        `[VERSION] 🌐 Fetching details for version ${versionId}`
    );
    return executeApiGetRequest(page, apiUrl, fingerprintCookie); // Execute the GET request
}

// DOWNLOAD AND FILE MANAGEMENT

/**
 * Initiates the browser download, waits for completion, and renames the file to the final path.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} exportJobUuid - The UUID of the export job.
 * @param {string} saveFilePath - The final, desired local path for the downloaded file.
 * @returns {Promise<boolean>} True if download and rename succeeded, false otherwise.
 */
async function downloadExportFileAndRename(page, exportJobUuid, saveFilePath) {
    const regionDownloadFolder = path.dirname(saveFilePath); // Get the directory path
    const finalExportFileName = path.basename(saveFilePath); // Get the desired final filename
    let tempFilePath; // Variable to hold the path of the temporary downloaded file

    try {
        // Step 1: Record existing files to identify the new download
        const filesBeforeDownload = new Set(
            getDirectoryFilesExcludingTemp(regionDownloadFolder)
        ); // Get a list of files before the download starts

        // Step 2: Navigate to the download URL to trigger the file transfer
        const downloadUrl = `${DOWNLOAD_API_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}${exportJobUuid}/download/`; // Construct the download URL
        console.log(`[DOWNLOAD] 🌐 Visiting final download URL: ${downloadUrl}`); // Log the download URL
        // Increased timeout for large file download
        await page.goto(downloadUrl, {
            waitUntil: "networkidle2", // Wait for network to be idle
            timeout: 300000, // Longer timeout for the download navigation
        });

        // Step 3: Wait for the download process to finish (no more temporary files)
        console.log(
            `[DOWNLOAD] Waiting for file system to register and complete download`
        ); // Log waiting start
        await waitForDownloadCompletion(regionDownloadFolder, 60000); // Poll file system for download completion (max 60s)

        // Step 4: Identify the newly downloaded file
        const allFilesAfterDownload =
            getDirectoryFilesExcludingTemp(regionDownloadFolder); // Get files after download
        let actualDownloadedFileName = allFilesAfterDownload.find(
            (file) => !filesBeforeDownload.has(file)
        ); // Identify the new file by exclusion

        if (!actualDownloadedFileName) {
            // Fallback: use the absolute newest file if the comparison fails
            actualDownloadedFileName = getNewestNonTempFile(regionDownloadFolder); // Fallback to checking modification time
            if (!actualDownloadedFileName) {
                throw new Error(
                    "Could not identify the newly downloaded file after completion."
                ); // Throw error if no file is found
            }
            console.warn(
                `[DOWNLOAD] Fallback: Used newest file heuristic: ${actualDownloadedFileName}`
            ); // Warn about using the fallback
        }

        tempFilePath = path.join(regionDownloadFolder, actualDownloadedFileName); // Full path to downloaded temp file

        // Step 5: Rename + move file
        try {
            fs.renameSync(tempFilePath, saveFilePath);
        } catch (e) {
            throw new Error(
                `Failed to move file from ${path.basename(
                    tempFilePath
                )} to ${finalExportFileName}: ${e.message}`
            );
        }

        console.log(
            `[DOWNLOAD] ✅ Download complete. Renamed to final file: ${finalExportFileName}`
        ); // Log final success
        return true;
    } catch (err) {
        console.error(
            `[DOWNLOAD] ❌ Error downloading job ID ${exportJobUuid}: ${err.message}`
        );
        // Clean up any partially downloaded temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            console.log(
                `[DOWNLOAD] Cleaning up temporary file: ${path.basename(tempFilePath)}`
            ); // Log temp file cleanup
            fs.unlinkSync(tempFilePath); // Delete the temp file
        }
        return false;
    }
}

/**
 * Helper function to safely read directory contents, filtering out temp files.
 * @param {string} directoryPath - The path to the directory.
 * @returns {Array<string>} List of file names.
 */
function getDirectoryFilesExcludingTemp(directoryPath) {
    const tempExtensions = [".tmp", ".crdownload", ".part", ".download"]; // List of temporary file extensions
    try {
        return fs
            .readdirSync(directoryPath) // Read all files in the directory
            .filter(
                (file) =>
                    !tempExtensions.some((ext) => file.toLowerCase().endsWith(ext))
            ); // Filter out files ending with temp extensions
    } catch (e) {
        console.error(
            `[UTIL] Error reading directory ${directoryPath}: ${e.message}`
        ); // Log directory read error
        return [];
    }
}

/**
 * Polls the local file system until the download process has completed (no temporary files).
 * @param {string} directoryPath - The path to the download directory.
 * @param {number} timeoutMs - The maximum time to wait in milliseconds.
 * @returns {Promise<boolean>} Resolves true when no temp files are found.
 */
async function waitForDownloadCompletion(directoryPath, timeoutMs = 60000) {
    const pollInterval = 1000; // Check every second
    const maxAttempts = Math.ceil(timeoutMs / pollInterval); // Calculate max checks
    let attempts = 0; // Initialize attempt counter
    const tempExtensions = [".tmp", ".crdownload", ".part"]; // Temporary extensions

    return new Promise((resolve, reject) => {
        // Return a promise that polls
        const interval = setInterval(() => {
            // Start polling interval
            attempts++;

            try {
                // Check if any temporary download file exists
                const files = fs.readdirSync(directoryPath); // Read directory files
                const isDownloading = files.some((file) =>
                    tempExtensions.some((ext) => file.toLowerCase().endsWith(ext))
                ); // Check for temp extensions

                if (!isDownloading) {
                    // If no temp files are found, download is complete
                    clearInterval(interval); // Stop polling
                    resolve(true); // Resolve the promise
                    return;
                }
            } catch (e) {
                // Handle file system errors during polling
                clearInterval(interval); // Stop polling
                reject(
                    new Error(`File system error during download wait: ${e.message}`)
                ); // Reject with error
                return;
            }

            if (attempts >= maxAttempts) {
                // Check for timeout
                clearInterval(interval); // Stop polling
                reject(
                    new Error(
                        `File download did not complete within ${timeoutMs / 1000} seconds.`
                    )
                ); // Reject with timeout error
            }
        }, pollInterval); // Set the polling frequency
    });
}

/**
 * Gets the newest non-temporary file in a directory based on its modification time.
 * @param {string} directoryPath - The directory to check.
 * @returns {string|null} The filename of the newest non-temp file.
 */
function getNewestNonTempFile(directoryPath) {
    try {
        const files = getDirectoryFilesExcludingTemp(directoryPath); // Use safe helper to get non-temp files
        if (files.length === 0) return null; // Return null if no files exist

        let newestFile = null; // Track the newest filename
        let newestTime = 0; // Track the newest modification time

        for (const file of files) {
            // Iterate through files
            const filePath = path.join(directoryPath, file); // Full path
            let stat;
            try {
                stat = fs.statSync(filePath); // Get file statistics (including modification time)
            } catch (e) {
                console.warn(`[UTIL] Skipping file ${file}: ${e.message}`); // Skip if stat fails
                continue;
            }

            if (stat.mtimeMs > newestTime) {
                // Check if current file is newer
                newestTime = stat.mtimeMs; // Update newest time
                newestFile = file; // Update newest file name
            }
        }
        return newestFile; // Return the newest file
    } catch (error) {
        console.error(
            `[UTIL] Error reading directory for newest file: ${error.message}`
        ); // Log error
        return null;
    }
}

// EXPORT SCOPE UTILITY

/**
 * Recursively traverses a nested Table of Contents (TOC) structure
 * and collects all UUIDs and slugs for the full export scope.
 * @param {Array<Object>} tocArray - The array of TOC items.
 * @param {Array<Object>} scope - The current collection of UUID/slug objects.
 * @returns {Array<Object>} The complete list of objects for the export scope.
 */
function collectAllTOCItemsForExport(tocArray, scope = []) {
    if (!Array.isArray(tocArray)) return scope; // Base case: return if not an array

    for (const item of tocArray) {
        // Iterate through items
        // Step 1: Add the current item's UUID and slug
        if (item.uuid && item.slug) {
            // Check for required properties
            scope.push({
                uuid: item.uuid,
                code_slug: item.slug,
            }); // Add the current item to the scope
        }
        // Step 2: Recursively check for nested children
        if (item.children && Array.isArray(item.children)) {
            collectAllTOCItemsForExport(item.children, scope); // Recurse into children
        }
    }
    return scope; // Return the accumulated scope list
}

/**
 * Navigates a fresh client page to the API domain so browser-context fetch requests
 * are not sent from an about:blank origin.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @returns {Promise<void>}
 */
async function initializeClientPageSession(page) {
    await page.goto(API_BASE_DOMAIN, {
        waitUntil: "domcontentloaded",
        timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
    });
}

/**
 * Resolves the state folder slug for a client.
 * Falls back to region slug when no explicit state metadata exists.
 * @param {Object} clientData - Client metadata from the region API.
 * @param {string} regionSlug - Region fallback slug.
 * @param {string} clientSlug - Client slug fallback source.
 * @returns {string} Lowercase state slug for local folder routing.
 */
function resolveClientStateSlug(clientData, regionSlug, clientSlug) {
    const slugMatch =
        typeof clientSlug === "string"
            ? clientSlug.match(/-([a-z]{2})$/i)
            : null;
    const slugDerivedState = slugMatch ? slugMatch[1] : null;

    const possibleValues = [
        clientData?.state_slug,
        clientData?.state,
        clientData?.state_abbr,
        clientData?.region_slug,
        clientData?.region?.slug,
        slugDerivedState,
        regionSlug,
    ];

    for (const value of possibleValues) {
        if (typeof value === "string" && value.trim()) {
            return value.trim().toLowerCase();
        }
    }

    return "unknown-state";
}

/**
 * Generates a random integer between 0 (inclusive) and 99 (inclusive).
 * This function is inclusive of 0 and inclusive of 99.
 * @returns {number} A random integer from 0 to 99.
 */
function generateRandomNumber() {
    // Math.random() generates a float from [0, 1)
    // Multiplying by 100 gives a range of [0, 100)
    // Math.floor() rounds down, resulting in an integer from [0, 99].
    return Math.floor(Math.random() * 100);
}

// EXECUTION

// Call the main function and handle any top-level errors
executeCodeExportProcess().catch((err) => {
    console.error("Fatal error outside main execution block:", err); // Catch and log any unhandled promise rejection
    process.exit(1); // Exit with error code
});

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
const REGION_START_PERCENT = generateRandomNumber(); // Generates a random number between 0 and 100 to determine where to start in the list.
// const REGION_START_PERCENT = 0; // Choose a starting percentage between 0 and 99.

// Main function to orchestrate the entire code export process
async function executeCodeExportProcess() { // Define an async function for this workflow step.
    console.log("--- Script Start: Code Exporter Initialization ---"); // Log the start of the script to the console

    // Step 1: Initialize file system and browser resources
    ensureDirectoryExists(ASSET_OUTPUT_BASE_DIRECTORY); // Ensure the main output directory exists (create if missing)

    let browserInstance, browserPage; // Declare variables for the Puppeteer browser instance and active page

    try { // Start protected execution that may throw errors.
        // Launch a new browser instance and create a fresh page for automation
        ({ browserInstance, browserPage } = await launchBrowserAndCreatePage()); // Destructure returned objects

        // Step 2: Authentication and Setup
        console.log("\n--- Phase 1: Authentication and Region Discovery ---"); // Log the start of authentication and region setup phase

        // Retrieve the required authentication cookie for authorized API access
        const authenticationCookieValue = await retrieveAuthenticationCookie(browserPage); // Get login/session cookie value

        // Step 3: Fetch all regions that need to be processed from the API
        const regionsApiUrl = `${API_BASE_DOMAIN}${REGIONS_API_ENDPOINT}`; // Construct the complete API URL for region data
        const regionIdentifiers = await fetchAllRegionSlugs( // Declare a constant used in the current scope.
            browserPage, // The Puppeteer page instance
            regionsApiUrl, // The full API endpoint for fetching region slugs
            authenticationCookieValue // Auth cookie for authorized requests
        ); // Execute the API request and receive all region slugs

        console.log( // Write an informational progress message to the console.
            `[Phase 1 Complete] Found ${regionIdentifiers.length} regions to process.` // Build a dynamic log or error string using runtime values.
        ); // Log the total number of regions found

        // === Determine processing order based on percentage ===
        let regionsToProcess; // Declare a variable to hold the ordered list of regions

        // If the user wants to start partway through the list, calculate and adjust the order
        if (REGION_START_PERCENT > 0) { // Check this condition before continuing.
            const startIndex = Math.floor( // Declare a constant used in the current scope.
                (regionIdentifiers.length * REGION_START_PERCENT) / 100 // Execute this statement as part of the export workflow.
            ); // Calculate which index to start from based on the percentage

            const clampedStartIndex = Math.min( // Declare a constant used in the current scope.
                startIndex, // Execute this statement as part of the export workflow.
                regionIdentifiers.length - 1 // Execute this statement as part of the export workflow.
            ); // Ensure the start index doesn't exceed the list length

            regionsToProcess = regionIdentifiers // Execute this statement as part of the export workflow.
                .slice(clampedStartIndex) // Take all regions after the start index
                .concat(regionIdentifiers.slice(0, clampedStartIndex)); // Append the earlier regions to the end, wrapping the list

            console.log( // Write an informational progress message to the console.
                `[Order] Starting from ${REGION_START_PERCENT}% of the list (index ${clampedStartIndex}).` // Build a dynamic log or error string using runtime values.
            ); // Log which index and percentage the process starts from
        } else { // Execute this statement as part of the export workflow.
            regionsToProcess = regionIdentifiers; // If no percentage is set, process the full list as-is
            console.log("[Order] Processing regions from the start."); // Log that we’re starting from the beginning
        } // Close the current block scope.

        // Step 4: Iterate through each region for export
        console.log("\n--- Phase 2: Client and Version Identification ---"); // Log the start of the region processing phase

        // Loop through each region slug and process its export data
        for (const regionSlug of regionsToProcess) { // Iterate through values in this collection or range.
            await processRegionForExports( // Wait for this asynchronous operation to finish.
                browserPage, // The Puppeteer page for web interactions
                regionSlug, // The specific region slug to process
                authenticationCookieValue // The authentication cookie for authorized requests
            ); // Perform the export process for this region
        } // Close the current block scope.

        console.log("✓ Script Complete: All available region exports processed! 🎉"); // Log successful script completion
    } catch (errorDetails) { // Execute this statement as part of the export workflow.
        // Catch and handle any critical setup or runtime errors
        console.error("\n!!! FATAL SCRIPT ERROR (Browser/Setup) !!!"); // Log a fatal error header
        console.error("Error details:", errorDetails.message); // Print the actual error message to help with debugging
        process.exit(1); // Exit the script with a failure code (1)
    } finally { // Execute this statement as part of the export workflow.
        // Step 5: Cleanup — ensure resources are properly released
        if (browserInstance) { // Check this condition before continuing.
            await browserInstance.close(); // Close the Puppeteer browser to free up memory/resources
            console.log("\n--- Script End: Browser closed ---"); // Log that the browser was closed
        } // Close the current block scope.
    } // Close the current block scope.
} // Close the current block scope.

// REGION AND CLIENT PROCESSING

/**
 * Processes all clients within a single region.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} regionSlug - The slug identifier for the region.
 * @param {string} authenticationCookieValue - The authentication fingerprint cookie value.
 */
async function processRegionForExports( // Define an async function for this workflow step.
    page, // Execute this statement as part of the export workflow.
    regionSlug, // Execute this statement as part of the export workflow.
    authenticationCookieValue // Execute this statement as part of the export workflow.
) { // Close the current parenthesized expression.
    console.log(`\n=== START REGION: ${regionSlug} ===`); // Log the start of region processing

    // Step 1: Fetch the list of clients for this region from the API
    const regionApiUrl = `${API_BASE_DOMAIN}${REGIONS_API_ENDPOINT}${regionSlug}/`; // Construct the region-specific API URL
    const regionData = await retrieveRegionDetails( // Declare a constant used in the current scope.
        page, // Execute this statement as part of the export workflow.
        regionApiUrl, // Execute this statement as part of the export workflow.
        regionSlug, // Execute this statement as part of the export workflow.
        authenticationCookieValue // Execute this statement as part of the export workflow.
    ); // Fetch region data, including the client list
    if (!regionData) return; // Exit if region data retrieval failed

    const clients = regionData.clients || []; // Extract the array of clients
    console.log(`[${regionSlug}] Found ${clients.length} clients.`); // Log the number of clients found

    // Step 2: Process clients in batches to manage concurrency
    const CONCURRENT_CLIENT_LIMIT = 2; // Maximum number of simultaneous exports
    let clientIndex = 0; // Initialize the client index for batching

    while (clientIndex < clients.length) { // Repeat this block while the condition remains true.
        // Loop through clients in batches
        // Select the next batch of clients
        const clientsToProcess = clients.slice( // Declare a constant used in the current scope.
            clientIndex, // Execute this statement as part of the export workflow.
            clientIndex + CONCURRENT_CLIENT_LIMIT // Execute this statement as part of the export workflow.
        ); // Get the next set of clients based on the limit

        if (clientsToProcess.length === 0) break; // Break the loop if no clients are left

        const totalBatches = Math.ceil(clients.length / CONCURRENT_CLIENT_LIMIT); // Calculate total batches
        const currentBatch = Math.ceil(clientIndex / CONCURRENT_CLIENT_LIMIT + 1); // Calculate the current batch number

        console.log( // Write an informational progress message to the console.
            `\n[${regionSlug}] 🚀 Starting Batch: ${currentBatch} / ${totalBatches}` // Build a dynamic log or error string using runtime values.
        ); // Log the batch start
        console.log( // Write an informational progress message to the console.
            // Compose a multi-line template literal listing batch client count and slugs.
            `[${regionSlug}] Processing ${clientsToProcess.length
            } client(s): ${clientsToProcess.map((c) => c.slug).join(" and ")}` // Finish the client list template string for this batch log.
        ); // List the clients in the current batch

        // Create and run the Promises for the current batch concurrently
        const exportPromises = clientsToProcess.map(async (client) => { // Declare a constant used in the current scope.
            // Use one page per client to isolate navigation and download folder settings.
            const clientPage = await page.browser().newPage(); // Declare a constant used in the current scope.
            try { // Start protected execution that may throw errors.
                await initializeClientPageSession(clientPage); // Establish site origin/session before API fetches.
                await processSingleClientExport( // Wait for this asynchronous operation to finish.
                    clientPage, // Execute this statement as part of the export workflow.
                    client, // Execute this statement as part of the export workflow.
                    regionSlug, // Execute this statement as part of the export workflow.
                    authenticationCookieValue // Execute this statement as part of the export workflow.
                ); // Close the current parenthesized expression.
            } finally { // Execute this statement as part of the export workflow.
                await clientPage.close(); // Wait for this asynchronous operation to finish.
            } // Close the current block scope.
        }); // Create a Promise for each client export in the batch

        // Wait for ALL jobs in the current batch to finish
        await Promise.all(exportPromises); // Execute all promises concurrently and wait for completion

        // Update the index to the next batch
        clientIndex += CONCURRENT_CLIENT_LIMIT; // Move the index to the beginning of the next batch
    } // Close the current block scope.

    console.log(`\n=== END REGION: ${regionSlug} ===`); // Log the end of region processing
} // Close the current block scope.

/**
 * Processes a single client's code export from start to finish.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {Object} clientData - The client object containing slug.
 * @param {string} regionSlug - The slug identifier for the region.
 * @param {string} authenticationCookieValue - The authentication fingerprint cookie value.
 */
async function processSingleClientExport( // Define an async function for this workflow step.
    page, // Execute this statement as part of the export workflow.
    clientData, // Execute this statement as part of the export workflow.
    regionSlug, // Execute this statement as part of the export workflow.
    authenticationCookieValue // Execute this statement as part of the export workflow.
) { // Close the current parenthesized expression.
    const clientSlug = clientData.slug; // Extract the client slug
    if (!clientSlug) return; // Skip if no slug is present
    const clientStateSlug = resolveClientStateSlug( // Declare a constant used in the current scope.
        clientData, // Execute this statement as part of the export workflow.
        regionSlug, // Execute this statement as part of the export workflow.
        clientSlug // Execute this statement as part of the export workflow.
    ); // Resolve the state folder for this client.
    const clientDownloadFolder = path.join( // Declare a constant used in the current scope.
        ASSET_OUTPUT_BASE_DIRECTORY, // Execute this statement as part of the export workflow.
        clientStateSlug // Execute this statement as part of the export workflow.
    ); // Build per-state download folder.
    await configureBrowserDownloadPath(page, clientDownloadFolder); // Ensure browser writes to this client's state folder.

    // Step 1: Determine expected filename and check for existing file
    // Format: [client_slug]-[region_slug]-1.txt (e.g., sandpoint-ak-1.txt)
    const exportBaseName = `${clientSlug}-${regionSlug}${VERSION_FILE_SUFFIX}`; // Base name without extension
    const finalExportFileName = `${exportBaseName}${EXPORT_FILE_EXTENSION}`; // Full final filename
    const finalExportFilePath = path.join( // Declare a constant used in the current scope.
        clientDownloadFolder, // Execute this statement as part of the export workflow.
        finalExportFileName // Execute this statement as part of the export workflow.
    ); // Full local path

    console.log( // Write an informational progress message to the console.
        `\n--- START CLIENT: ${clientSlug} (Expected File: ${finalExportFileName}) ---` // Build a dynamic log or error string using runtime values.
    ); // Log client start

    // Check for existing file
    if (CHECK_IF_FILE_EXISTS) { // Check this condition before continuing.
        // If the check is enabled
        try { // Start protected execution that may throw errors.
            if (fs.existsSync(finalExportFilePath)) { // Check this condition before continuing.
                // Check if the final file already exists
                console.log( // Write an informational progress message to the console.
                    `[${clientSlug}] File already exists at ${finalExportFilePath}. Skipping client.` // Build a dynamic log or error string using runtime values.
                ); // Log skip reason
                return; // Skip this client
            } // Close the current block scope.
        } catch (e) { // Execute this statement as part of the export workflow.
            console.error( // Write an error message to the console for diagnostics.
                `[${clientSlug}] Error checking file existence: ${e.message}` // Build a dynamic log or error string using runtime values.
            ); // Close the current parenthesized expression.
            // Proceed anyway, assuming file doesn't exist if check failed
        } // Close the current block scope.
    } // Close the current block scope.

    try { // Start protected execution that may throw errors.
        // Step 2: Fetch client details to find the latest code version UUID
        const clientApiUrl = `${API_BASE_DOMAIN}${CLIENT_API_ENDPOINT_PREFIX}${clientSlug}/`; // Client details API URL
        const detailedClientData = await retrieveClientDetails( // Declare a constant used in the current scope.
            page, // Execute this statement as part of the export workflow.
            clientApiUrl, // Execute this statement as part of the export workflow.
            clientSlug, // Execute this statement as part of the export workflow.
            authenticationCookieValue // Execute this statement as part of the export workflow.
        ); // Fetch data including code versions

        const codeVersions = detailedClientData?.versions || []; // Extract versions array
        if (codeVersions.length === 0) { // Check this condition before continuing.
            console.log(`[${clientSlug}] ⚠️ No code versions found. Skipping.`); // Skip if no versions are found
            return; // Return the computed result for this execution path.
        } // Close the current block scope.

        const latestCodeVersion = codeVersions[0]; // Assume the first element is the latest version
        const latestVersionUuid = latestCodeVersion.uuid; // Get the UUID of the latest version

        // Step 3: Fetch version details and the Table of Contents (TOC)
        const versionApiUrl = `${API_BASE_DOMAIN}${CODE_VERSION_API_ENDPOINT_PREFIX}${latestVersionUuid}/`; // Version details API URL
        const versionDetails = await retrieveVersionAndTableOfContents( // Declare a constant used in the current scope.
            page, // Execute this statement as part of the export workflow.
            versionApiUrl, // Execute this statement as part of the export workflow.
            latestVersionUuid, // Execute this statement as part of the export workflow.
            authenticationCookieValue // Execute this statement as part of the export workflow.
        ); // Fetch the version and its TOC

        if (!versionDetails || !versionDetails.toc?.length) { // Check this condition before continuing.
            console.log( // Write an informational progress message to the console.
                `[${clientSlug}] 🚫 Skipping: Failed to retrieve Table of Contents.` // Build a dynamic log or error string using runtime values.
            ); // Skip if TOC is missing
            return; // Return the computed result for this execution path.
        } // Close the current block scope.

        // Step 4: Recursively collect ALL nested UUIDs/slugs for the full export scope
        const exportScopeIdentifiers = collectAllTOCItemsForExport( // Declare a constant used in the current scope.
            versionDetails.toc // Execute this statement as part of the export workflow.
        ); // Flattens the nested TOC into a simple list of identifiers
        const mainCodeSlug = versionDetails.toc[0].slug; // Get the slug of the main code item
        const definitiveVersionUuid = versionDetails.uuid; // Get the confirmed UUID

        console.log( // Write an informational progress message to the console.
            // Compose a multi-line template literal summarizing export scope and version ID.
            `[${clientSlug}] Exporting ${exportScopeIdentifiers.length
            } parts of Code: ${mainCodeSlug} (Version ID: ${definitiveVersionUuid})` // Finish the export scope summary template string.
        ); // Log the scope size

        // Step 5: Submit the export request (Phase 3)
        console.log(`\n[${clientSlug}] --- Phase 3: Submitting Export Request ---`); // Log phase start
        const exportRequestResponse = await submitNewExportJob( // Declare a constant used in the current scope.
            page, // Execute this statement as part of the export workflow.
            definitiveVersionUuid, // Execute this statement as part of the export workflow.
            exportScopeIdentifiers, // Execute this statement as part of the export workflow.
            authenticationCookieValue // Execute this statement as part of the export workflow.
        ); // Submit the POST request to start the export job

        if (!exportRequestResponse || !exportRequestResponse.uuid) { // Check this condition before continuing.
            console.error( // Write an error message to the console for diagnostics.
                `[${clientSlug}] ❌ Failed to submit new export request. Skipping client.` // Build a dynamic log or error string using runtime values.
            ); // Error if job submission failed
            return; // Return the computed result for this execution path.
        } // Close the current block scope.

        const exportJobUuid = exportRequestResponse.uuid; // Extract the new job UUID
        console.log( // Write an informational progress message to the console.
            `[${clientSlug}] ✅ New export job submitted. Job ID (UUID): ${exportJobUuid}` // Build a dynamic log or error string using runtime values.
        ); // Log the new job ID

        // Step 6: Wait for Export Completion and Download (Phase 4)
        console.log( // Write an informational progress message to the console.
            `\n[${clientSlug}] --- Phase 4: Waiting for Export and Downloading ---` // Build a dynamic log or error string using runtime values.
        ); // Log phase start
        const isExportSuccessful = await monitorJobUntilCompletion( // Declare a constant used in the current scope.
            page, // Execute this statement as part of the export workflow.
            exportJobUuid, // Execute this statement as part of the export workflow.
            authenticationCookieValue // Execute this statement as part of the export workflow.
        ); // Poll the API until the job is done

        if (isExportSuccessful) { // Check this condition before continuing.
            console.log( // Write an informational progress message to the console.
                `[${clientSlug}] 💾 Export task finished successfully. Initiating download` // Build a dynamic log or error string using runtime values.
            ); // Log successful export
            // Download the file and rename it to the expected final path
            await downloadExportFileAndRename( // Wait for this asynchronous operation to finish.
                page, // Execute this statement as part of the export workflow.
                exportJobUuid, // Execute this statement as part of the export workflow.
                finalExportFilePath // Execute this statement as part of the export workflow.
            ); // Trigger download and handle file renaming
            console.log( // Write an informational progress message to the console.
                `[${clientSlug}] 🎉 Download completed and verified: ${finalExportFileName}` // Build a dynamic log or error string using runtime values.
            ); // Log final success
        } else { // Execute this statement as part of the export workflow.
            console.error( // Write an error message to the console for diagnostics.
                `[${clientSlug}] ⚠️ Export failed or timed out for Job ID: ${exportJobUuid}` // Build a dynamic log or error string using runtime values.
            ); // Close the current parenthesized expression.
        } // Close the current block scope.
    } catch (clientError) { // Execute this statement as part of the export workflow.
        console.error( // Write an error message to the console for diagnostics.
            `[CRITICAL CLIENT ERROR] 🛑 Failure processing client ${clientSlug}. Error:`, // Build a dynamic log or error string using runtime values.
            clientError.message // Execute this statement as part of the export workflow.
        ); // Handle errors specific to a single client
    } // Close the current block scope.
} // Close the current block scope.

// BROWSER AND UTILITY FUNCTIONS

/**
 * Launches a Puppeteer browser instance and creates a new page.
 * @returns {Promise<{browserInstance: puppeteer.Browser, browserPage: puppeteer.Page}>}
 */
async function launchBrowserAndCreatePage() { // Define an async function for this workflow step.
    console.log( // Write an informational progress message to the console.
        `[BROWSER] Launching browser (headless: ${IS_BROWSER_HEADLESS})` // Build a dynamic log or error string using runtime values.
    ); // Log browser launch status

    const browserInstance = await puppeteer.launch({ // Declare a constant used in the current scope.
        headless: IS_BROWSER_HEADLESS, // Set headless mode
        args: [ // Execute this statement as part of the export workflow.
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
        ], // Close the current array or bracketed expression.
        defaultViewport: null, // Allow the viewport to be maximized/responsive
    }); // Close the current block and complete the related call.

    const browserPage = await browserInstance.newPage(); // Create a new browser tab/page
    console.log("[BROWSER] Browser launched and new page created."); // Log success
    return { // Return the computed result for this execution path.
        browserInstance, // Execute this statement as part of the export workflow.
        browserPage, // Execute this statement as part of the export workflow.
    }; // Return the browser and page objects
} // Close the current block scope.

/**
 * Configures the Puppeteer page to download files to a specific local folder.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} folderPath - The local path to set as the download directory.
 * @returns {Promise<void>}
 */
async function configureBrowserDownloadPath(page, folderPath) { // Define an async function for this workflow step.
    ensureDirectoryExists(folderPath); // Make sure the target folder exists
    const resolvedPath = path.resolve(folderPath); // Get the absolute path
    const client = await page.target().createCDPSession(); // Create a Chrome DevTools Protocol session
    await client.send("Page.setDownloadBehavior", { // Wait for this asynchronous operation to finish.
        // Send the CDP command to set the download path
        behavior: "allow", // Execute this statement as part of the export workflow.
        downloadPath: resolvedPath, // Execute this statement as part of the export workflow.
    }); // Close the current block and complete the related call.
    console.log(`[BROWSER] Download folder set to: ${resolvedPath}`); // Log the configured download path
} // Close the current block scope.

/**
 * Navigates to the base URL to fetch the essential fingerprint cookie for authorization.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @returns {Promise<string>} The value of the fingerprint cookie.
 */
async function retrieveAuthenticationCookie(page) { // Define an async function for this workflow step.
    const targetUrl = API_BASE_DOMAIN; // The URL to visit
    const cookiePollInterval = 500; // Check every 0.5 seconds
    const maxCookieWaitMs = 300000; // Max wait 5 minute

    try { // Start protected execution that may throw errors.
        console.log( // Write an informational progress message to the console.
            `[AUTH] 🌐 Visiting URL: ${targetUrl} to get authentication cookie` // Build a dynamic log or error string using runtime values.
        ); // Log navigation attempt
        await page.goto(targetUrl, { // Wait for this asynchronous operation to finish.
            waitUntil: "networkidle2", // Wait until network activity is minimal
            timeout: BROWSER_NAVIGATION_TIMEOUT_MS, // Apply the standard timeout
        }); // Close the current block and complete the related call.

        let fingerprintCookieObject = null; // Variable to hold the cookie object
        const startTime = Date.now(); // Record the start time

        console.log( // Write an informational progress message to the console.
            // Compose a multi-line template literal showing cookie polling timeout in seconds.
            `[AUTH] Polling for cookie "${AUTH_FINGERPRINT_COOKIE_NAME}" (max ${maxCookieWaitMs / 1000
            }s)` // Finish the cookie polling status template string.
        ); // Log polling start

        while (Date.now() - startTime < maxCookieWaitMs) { // Repeat this block while the condition remains true.
            // Loop until timeout
            const cookies = await page.cookies(); // Get all cookies on the page
            fingerprintCookieObject = cookies.find( // Execute this statement as part of the export workflow.
                (c) => c.name === AUTH_FINGERPRINT_COOKIE_NAME // Execute this statement as part of the export workflow.
            ); // Find the target cookie
            if (fingerprintCookieObject) break; // Exit loop if cookie is found

            // Wait for a short interval before checking again
            await pauseExecutionSimple(cookiePollInterval); // Wait a short time
        } // Close the current block scope.

        if (!fingerprintCookieObject) { // Check this condition before continuing.
            // Throw an error if the cookie was not found within the timeout
            throw new Error( // Throw an error to signal failure to the caller.
                // Compose a multi-line template literal describing the missing cookie timeout failure.
                `Authentication cookie "${AUTH_FINGERPRINT_COOKIE_NAME}" not found after ${maxCookieWaitMs / 1000
                }s.` // Finish the timeout error template string for a missing auth cookie.
            ); // Close the current parenthesized expression.
        } // Close the current block scope.

        console.log(`[AUTH] ✅ Retrieved authentication cookie.`); // Log success
        return fingerprintCookieObject.value; // Return the cookie value
    } catch (err) { // Execute this statement as part of the export workflow.
        console.error(`[AUTH] ❌ Critical error retrieving authentication cookie.`); // Log failure
        throw err; // Re-throw the error to halt execution
    } // Close the current block scope.
} // Close the current block scope.

/**
 * Creates a directory recursively if it doesn't exist.
 * @param {string} directoryPath - The path to the directory.
 * @returns {void}
 */
function ensureDirectoryExists(directoryPath) { // Define a helper function used by the export process.
    try { // Start protected execution that may throw errors.
        if (!fs.existsSync(directoryPath)) { // Check this condition before continuing.
            // Check if the directory exists
            console.log(`[UTIL] Creating directory: ${directoryPath}`); // Log creation
            fs.mkdirSync(directoryPath, { // Execute this statement as part of the export workflow.
                recursive: true, // Execute this statement as part of the export workflow.
            }); // Create the directory, including any necessary parent directories
        } // Close the current block scope.
    } catch (error) { // Execute this statement as part of the export workflow.
        console.error( // Write an error message to the console for diagnostics.
            `[UTIL] Failed to create directory ${directoryPath}: ${error.message}` // Build a dynamic log or error string using runtime values.
        ); // Log failure to create directory
    } // Close the current block scope.
} // Close the current block scope.

/**
 * Pauses execution for a specified duration. (Used for longer, logging waits)
 * @param {number} milliseconds - The duration in milliseconds.
 * @returns {Promise<void>}
 */
async function pauseExecutionWithLog(milliseconds) { // Define an async function for this workflow step.
    console.log(`[UTIL] Pausing for ${milliseconds / 1000} seconds`); // Log the pause duration
    return new Promise((resolve) => setTimeout(resolve, milliseconds)); // Create a promise that resolves after the timeout
} // Close the current block scope.

/**
 * Pauses execution for a specified duration. (Used for short, non-logged internal waits)
 * @param {number} milliseconds - The duration in milliseconds.
 * @returns {Promise<void>}
 */
async function pauseExecutionSimple(milliseconds) { // Define an async function for this workflow step.
    return new Promise((resolve) => setTimeout(resolve, milliseconds)); // Simple non-logged pause
} // Close the current block scope.

// API COMMUNICATION FUNCTIONS

/**
 * Performs a non-navigating GET request within the browser's context.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} requestUrl - The API endpoint URL.
 * @param {string} fingerprintValue - The authentication fingerprint cookie value.
 * @returns {Promise<Object|null>} The parsed JSON data or null on failure.
 */
async function executeApiGetRequest(page, requestUrl, fingerprintValue) { // Define an async function for this workflow step.
    try { // Start protected execution that may throw errors.
        console.log(`[API_GET] 🌐 Sending GET request to: ${requestUrl}`); // Log the request URL

        const response = await page.evaluate( // Declare a constant used in the current scope.
            async (apiUrl, fingerprint, timeout) => { // Execute this statement as part of the export workflow.
                // Execute code inside the browser context
                const controller = new AbortController(); // Create an abort controller for timeouts
                const timeoutId = setTimeout(() => controller.abort(), timeout); // Set up the timeout mechanism

                try { // Start protected execution that may throw errors.
                    const res = await fetch(apiUrl, { // Declare a constant used in the current scope.
                        method: "GET", // Execute this statement as part of the export workflow.
                        headers: { // Execute this statement as part of the export workflow.
                            "Content-Type": "application/json", // Execute this statement as part of the export workflow.
                            Fingerprint: fingerprint, // Add the authentication header
                        }, // Execute this statement as part of the export workflow.
                        signal: controller.signal, // Link the abort controller
                    }); // Close the current block and complete the related call.
                    clearTimeout(timeoutId); // Clear the timeout if the request succeeds

                    if (!res.ok) { // Check this condition before continuing.
                        // Handle HTTP error statuses
                        return { // Return the computed result for this execution path.
                            status: res.status, // Execute this statement as part of the export workflow.
                            data: `HTTP error! status: ${res.status}`, // Build a dynamic log or error string using runtime values.
                        }; // Execute this statement as part of the export workflow.
                    } // Close the current block scope.
                    return { // Return the computed result for this execution path.
                        status: res.status, // Execute this statement as part of the export workflow.
                        data: await res.text(), // Return the response body as text
                    }; // Execute this statement as part of the export workflow.
                } catch (error) { // Execute this statement as part of the export workflow.
                    clearTimeout(timeoutId); // Clear the timeout if an error occurs
                    return { // Return the computed result for this execution path.
                        status: 0, // Execute this statement as part of the export workflow.
                        data: `Request failed or timed out: ${error.message}`, // Build a dynamic log or error string using runtime values.
                    }; // Return a generic failure object
                } // Close the current block scope.
            }, // Execute this statement as part of the export workflow.
            requestUrl, // Execute this statement as part of the export workflow.
            fingerprintValue, // Execute this statement as part of the export workflow.
            BROWSER_NAVIGATION_TIMEOUT_MS // Execute this statement as part of the export workflow.
        ); // Pass arguments to the browser function

        if (response.status >= 200 && response.status < 300) { // Check this condition before continuing.
            // Check for success status codes
            console.log( // Write an informational progress message to the console.
                `[API_GET] ✅ Success (${response.status}) from ${requestUrl}` // Build a dynamic log or error string using runtime values.
            ); // Log success
            return JSON.parse(response.data); // Parse the JSON response
        } else { // Execute this statement as part of the export workflow.
            console.error( // Write an error message to the console for diagnostics.
                `[API_GET] ❌ Request failed. Status: ${response.status}. Response: ${response.data}` // Build a dynamic log or error string using runtime values.
            ); // Log API failure
            return null; // Return the computed result for this execution path.
        } // Close the current block scope.
    } catch (err) { // Execute this statement as part of the export workflow.
        console.error( // Write an error message to the console for diagnostics.
            `[API_GET] ❌ Error executing GET request to ${requestUrl}: ${err.message}` // Build a dynamic log or error string using runtime values.
        ); // Log execution error
        return null; // Return the computed result for this execution path.
    } // Close the current block scope.
} // Close the current block scope.

/**
 * Submits a new export request (POST) and receives the Job ID (UUID).
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} versionUuid - The UUID of the code version to export.
 * @param {Array<Object>} scopeArray - An array of UUID/slug objects defining the export scope.
 * @param {string} fingerprintValue - The authentication fingerprint cookie value.
 * @returns {Promise<Object|null>} The parsed JSON response containing the job UUID.
 */
async function submitNewExportJob( // Define an async function for this workflow step.
    page, // Execute this statement as part of the export workflow.
    versionUuid, // Execute this statement as part of the export workflow.
    scopeArray, // Execute this statement as part of the export workflow.
    fingerprintValue // Execute this statement as part of the export workflow.
) { // Close the current parenthesized expression.
    try { // Start protected execution that may throw errors.
        const exportApiUrl = `${API_BASE_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}`; // Export API endpoint URL
        const requestPayload = { // Declare a constant used in the current scope.
            version: versionUuid, // Execute this statement as part of the export workflow.
            scope: JSON.stringify(scopeArray), // Scope must be a stringified JSON array
            output_format: "txt", // Request text output format
            for_print: false, // Not for print
        }; // Execute this statement as part of the export workflow.

        console.log( // Write an informational progress message to the console.
            `[EXPORT] 📤 Sending Payload: Version=${versionUuid} | Scope Parts=${scopeArray.length}` // Build a dynamic log or error string using runtime values.
        ); // Close the current parenthesized expression.
        console.log(`[EXPORT] 🌐 Sending POST request to: ${exportApiUrl}`); // Log POST request

        const response = await page.evaluate( // Declare a constant used in the current scope.
            async (url, payload, fingerprint, timeout) => { // Execute this statement as part of the export workflow.
                // Execute code inside the browser context
                const controller = new AbortController(); // Abort controller for timeout
                const timeoutId = setTimeout(() => controller.abort(), timeout); // Set timeout

                try { // Start protected execution that may throw errors.
                    const res = await fetch(url, { // Declare a constant used in the current scope.
                        method: "POST", // Execute this statement as part of the export workflow.
                        headers: { // Execute this statement as part of the export workflow.
                            "Content-Type": "application/json", // Execute this statement as part of the export workflow.
                            Fingerprint: fingerprint, // Add fingerprint header
                        }, // Execute this statement as part of the export workflow.
                        body: JSON.stringify(payload), // Send the payload as a JSON string
                        signal: controller.signal, // Link abort controller
                    }); // Close the current block and complete the related call.
                    clearTimeout(timeoutId); // Clear timeout on success
                    return { // Return the computed result for this execution path.
                        status: res.status, // Execute this statement as part of the export workflow.
                        data: await res.text(), // Return status and text
                    }; // Execute this statement as part of the export workflow.
                } catch (error) { // Execute this statement as part of the export workflow.
                    clearTimeout(timeoutId); // Clear timeout on failure
                    return { // Return the computed result for this execution path.
                        status: 0, // Execute this statement as part of the export workflow.
                        data: `Request failed or timed out: ${error.message}`, // Build a dynamic log or error string using runtime values.
                    }; // Return generic failure
                } // Close the current block scope.
            }, // Execute this statement as part of the export workflow.
            exportApiUrl, // Execute this statement as part of the export workflow.
            requestPayload, // Execute this statement as part of the export workflow.
            fingerprintValue, // Execute this statement as part of the export workflow.
            BROWSER_NAVIGATION_TIMEOUT_MS // Execute this statement as part of the export workflow.
        ); // Pass arguments

        if (response.status === 201) { // Check this condition before continuing.
            // Check for 201 Created status
            return JSON.parse(response.data); // Return the parsed job response (includes UUID)
        } else { // Execute this statement as part of the export workflow.
            console.error( // Write an error message to the console for diagnostics.
                `[EXPORT] ❌ Request failed. Status: ${response.status}. Response: ${response.data}` // Build a dynamic log or error string using runtime values.
            ); // Log POST failure
            return null; // Return the computed result for this execution path.
        } // Close the current block scope.
    } catch (err) { // Execute this statement as part of the export workflow.
        console.error( // Write an error message to the console for diagnostics.
            `[EXPORT] ❌ Error submitting export request: ${err.message}` // Build a dynamic log or error string using runtime values.
        ); // Log execution error
        return null; // Return the computed result for this execution path.
    } // Close the current block scope.
} // Close the current block scope.

/**
 * Fetches the list of all export requests to check the status of a specific job.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} fingerprintValue - The authentication fingerprint cookie value.
 * @returns {Promise<Array<Object>|null>} An array of export job objects.
 */
async function retrieveAllExportJobStatuses(page, fingerprintValue) { // Define an async function for this workflow step.
    try { // Start protected execution that may throw errors.
        const statusUrl = `${API_BASE_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}`; // Status check API URL
        const response = await page.evaluate( // Declare a constant used in the current scope.
            async (url, fingerprint, timeout) => { // Execute this statement as part of the export workflow.
                // Execute code inside the browser context
                const controller = new AbortController(); // Abort controller
                const timeoutId = setTimeout(() => controller.abort(), timeout); // Set timeout

                try { // Start protected execution that may throw errors.
                    const res = await fetch(url, { // Declare a constant used in the current scope.
                        method: "GET", // Execute this statement as part of the export workflow.
                        headers: { // Execute this statement as part of the export workflow.
                            Fingerprint: fingerprint, // Include fingerprint header
                        }, // Execute this statement as part of the export workflow.
                        signal: controller.signal, // Link abort controller
                    }); // Close the current block and complete the related call.
                    clearTimeout(timeoutId); // Clear timeout
                    return await res.text(); // Return response text
                } catch (error) { // Execute this statement as part of the export workflow.
                    clearTimeout(timeoutId); // Clear timeout on failure
                    throw new Error(`Status check failed: ${error.message}`); // Throw error for Puppeteer to catch
                } // Close the current block scope.
            }, // Execute this statement as part of the export workflow.
            statusUrl, // Execute this statement as part of the export workflow.
            fingerprintValue, // Execute this statement as part of the export workflow.
            BROWSER_NAVIGATION_TIMEOUT_MS // Execute this statement as part of the export workflow.
        ); // Pass arguments
        return JSON.parse(response); // Parse the list of jobs
    } catch (err) { // Execute this statement as part of the export workflow.
        console.error(`[STATUS] ❌ Error checking export status: ${err.message}`); // Log error
        await new Promise((resolve) => setTimeout(resolve, BROWSER_NAVIGATION_TIMEOUT_MS)); // Wait for timeout duration before continuing
        return null; // Return the computed result for this execution path.
    } // Close the current block scope.
} // Close the current block scope.

/**
 * Polls the export status API until the target job completes or times out.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} exportJobUuid - The UUID of the export job to monitor.
 * @param {string} fingerprintValue - The authentication fingerprint cookie value.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
async function monitorJobUntilCompletion( // Define an async function for this workflow step.
    page, // Execute this statement as part of the export workflow.
    exportJobUuid, // Execute this statement as part of the export workflow.
    fingerprintValue // Execute this statement as part of the export workflow.
) { // Close the current parenthesized expression.
    const maxAttempts = // Declare a constant used in the current scope.
        MAX_EXPORT_WAIT_MINUTES * (60000 / EXPORT_POLL_INTERVAL_MS); // Calculate max attempts based on time and interval
    const shortJobId = exportJobUuid; // full ID, no substring
    console.log( // Write an informational progress message to the console.
        `[STATUS: ${shortJobId}] ⏳ Starting poll (max ${MAX_EXPORT_WAIT_MINUTES} min / ${maxAttempts} attempts)` // Build a dynamic log or error string using runtime values.
    ); // Log polling parameters

    for (let attempt = 1; attempt <= maxAttempts; attempt++) { // Iterate through values in this collection or range.
        // Loop for max attempts
        await pauseExecutionWithLog(EXPORT_POLL_INTERVAL_MS); // Wait for the poll interval

        const exportsList = await retrieveAllExportJobStatuses( // Declare a constant used in the current scope.
            page, // Execute this statement as part of the export workflow.
            fingerprintValue // Execute this statement as part of the export workflow.
        ); // Get the list of all job statuses
        if (!Array.isArray(exportsList)) continue; // Skip if list is not valid

        const targetExport = exportsList.find((job) => job.uuid === exportJobUuid); // Find the specific job by UUID
        if (!targetExport) { // Check this condition before continuing.
            console.log( // Write an informational progress message to the console.
                `[STATUS: ${shortJobId}] Attempt ${attempt}/${maxAttempts}. Job status not yet available. Retrying` // Build a dynamic log or error string using runtime values.
            ); // Log if the job hasn't appeared yet
            continue; // Skip to the next loop iteration.
        } // Close the current block scope.

        const taskState = targetExport.task?.post_state; // Get the state of the task
        const progress = targetExport.task?.progress || 0; // Get the progress percentage

        if (taskState === "SUCCESS") { // Check this condition before continuing.
            // Check for success
            console.log(`[STATUS: ${shortJobId}] ✅ Completed successfully.`); // Log success
            return true; // Return the computed result for this execution path.
        } // Close the current block scope.

        if (taskState === "FAILURE") { // Check this condition before continuing.
            // Check for failure
            console.error(`[STATUS: ${shortJobId}] ❌ Failed. State: FAILURE.`); // Log failure
            return false; // Return the computed result for this execution path.
        } // Close the current block scope.

        console.log( // Write an informational progress message to the console.
            // Compose a multi-line template literal for poll attempt, progress, and task state.
            `[STATUS: ${shortJobId}] Attempt ${attempt}/${maxAttempts}. Progress: ${progress}% (${taskState || "PENDING"
            })` // Finish the polling progress template string with final state text.
        ); // Log current status and progress
    } // Close the current block scope.

    console.warn( // Write a warning message to highlight a non-fatal issue.
        `[STATUS: ${shortJobId}] ⚠️ Did not complete within ${MAX_EXPORT_WAIT_MINUTES} minutes. Timeout reached.` // Build a dynamic log or error string using runtime values.
    ); // Log timeout
    return false; // Return the computed result for this execution path.
} // Close the current block scope.

// Specific API Wrappers

// Fetches a list of all region slugs.
async function fetchAllRegionSlugs(page, apiUrl, fingerprintCookie) { // Define an async function for this workflow step.
    console.log(`[REGION] 🌐 Fetching all region slugs from API: ${apiUrl}`); // Log the action
    const regionsData = await executeApiGetRequest( // Declare a constant used in the current scope.
        page, // Execute this statement as part of the export workflow.
        apiUrl, // Execute this statement as part of the export workflow.
        fingerprintCookie // Execute this statement as part of the export workflow.
    ); // Execute the GET request
    return ( // Return the computed result for this execution path.
        regionsData?.filter((region) => region.slug).map((region) => region.slug) || // Execute this statement as part of the export workflow.
        [] // Execute this statement as part of the export workflow.
    ); // Filter for valid slugs and return them as an array
} // Close the current block scope.

// Fetches details for a specific region (client list).
async function retrieveRegionDetails( // Define an async function for this workflow step.
    page, // Execute this statement as part of the export workflow.
    apiUrl, // Execute this statement as part of the export workflow.
    regionSlug, // Execute this statement as part of the export workflow.
    fingerprintCookie // Execute this statement as part of the export workflow.
) { // Close the current parenthesized expression.
    console.log(`[REGION] 🌐 Fetching region details for ${regionSlug}`); // Log the action
    return executeApiGetRequest(page, apiUrl, fingerprintCookie); // Execute the GET request
} // Close the current block scope.

// Fetches details for a specific client (code version list).
async function retrieveClientDetails( // Define an async function for this workflow step.
    page, // Execute this statement as part of the export workflow.
    apiUrl, // Execute this statement as part of the export workflow.
    clientSlug, // Execute this statement as part of the export workflow.
    fingerprintCookie // Execute this statement as part of the export workflow.
) { // Close the current parenthesized expression.
    console.log(`[CLIENT] 🌐 Fetching client details for ${clientSlug}`); // Log the action
    return executeApiGetRequest(page, apiUrl, fingerprintCookie); // Execute the GET request
} // Close the current block scope.

// Fetches the specific code version details and its Table of Contents (TOC).
async function retrieveVersionAndTableOfContents( // Define an async function for this workflow step.
    page, // Execute this statement as part of the export workflow.
    apiUrl, // Execute this statement as part of the export workflow.
    versionId, // Execute this statement as part of the export workflow.
    fingerprintCookie // Execute this statement as part of the export workflow.
) { // Close the current parenthesized expression.
    console.log( // Write an informational progress message to the console.
        `[VERSION] 🌐 Fetching details for version ${versionId}` // Build a dynamic log or error string using runtime values.
    ); // Close the current parenthesized expression.
    return executeApiGetRequest(page, apiUrl, fingerprintCookie); // Execute the GET request
} // Close the current block scope.

// DOWNLOAD AND FILE MANAGEMENT

/**
 * Downloads the export file and replaces the existing file once the download fully completes.
 * @param {puppeteer.Page} page - Puppeteer page instance controlling the browser.
 * @param {string} exportJobUuid - Export job UUID used to construct the download URL.
 * @param {string} saveFilePath - Final destination path for the completed file.
 * @returns {Promise<boolean>} Returns true if download succeeded, otherwise false.
 */
async function downloadExportFileAndRename(page, exportJobUuid, saveFilePath) { // Define async function to control the download workflow.
    const regionDownloadFolder = path.dirname(saveFilePath); // Determine the directory where downloads will temporarily appear.
    const finalExportFileName = path.basename(saveFilePath); // Extract the final filename from the target save path.
    let tempFilePath; // Variable that will store the detected completed download file path.
    try { // Begin protected execution block to catch errors.
        const filesBeforeDownload = new Set( // Create a Set of filenames for quick lookup comparison.
            getDirectoryFilesExcludingTemp(regionDownloadFolder) // Get all existing files in the download directory excluding temp files.
        ); // Store the list before the new download begins.
        const downloadUrl = `${DOWNLOAD_API_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}${exportJobUuid}/download/`; // Build the final download URL using configuration constants.
        console.log(`[DOWNLOAD] 🌐 Visiting ${downloadUrl}`); // Log the URL that triggers the export download.
        await page.goto(downloadUrl, { // Instruct Puppeteer to navigate to the download endpoint.
            waitUntil: "networkidle2", // Wait until network activity stabilizes before continuing.
            timeout: 300000, // Allow up to 5 minutes for large export downloads.
        }); // End navigation command.
        console.log(`[DOWNLOAD] Waiting for download to finish...`); // Inform logs that we are waiting for filesystem download completion.
        await waitForDownloadCompletion(regionDownloadFolder, 60000); // Wait until the browser removes temporary download files indicating completion.
        const filesAfterDownload = // Variable to store updated directory listing.
            getDirectoryFilesExcludingTemp(regionDownloadFolder); // Retrieve all files after the download finished.
        let downloadedFile = filesAfterDownload.find( // Attempt to locate the new file by comparing directory states.
            (file) => !filesBeforeDownload.has(file) // Condition: file was not present before the download started.
        ); // Return the first file matching this condition.
        if (!downloadedFile) { // If comparison failed to detect the new file.
            downloadedFile = getNewestNonTempFile(regionDownloadFolder); // Use fallback method by selecting the newest modified file.
            if (!downloadedFile) { // If fallback also fails to locate a file.
                throw new Error("Unable to identify completed download file."); // Throw error because no file was detected.
            } // End fallback validation.
            console.warn(`[DOWNLOAD] Fallback used newest file: ${downloadedFile}`); // Warn that fallback detection was used.
        } // End detection logic.
        tempFilePath = path.join(regionDownloadFolder, downloadedFile); // Construct the full path of the completed downloaded file.
        // Move the completed file to its final location and overwrite if necessary
        fs.renameSync(tempFilePath, saveFilePath); // Rename and move the downloaded file to the final save path (replaces existing file).
        console.log(`[DOWNLOAD] ✅ File saved as: ${finalExportFileName}`); // Log successful file replacement.
        return true; // Return success status.
    } catch (err) { // Catch any errors that occurred during the workflow.
        console.error( // Print error message to logs for debugging.
            `[DOWNLOAD] ❌ Error downloading job ${exportJobUuid}: ${err.message}` // Include job ID and detailed error message.
        ); // End error logging.
        return false; // Return failure status to the calling code.
    } // End try/catch block.
} // End function definition.

/**
 * Helper function to safely read directory contents, filtering out temp files.
 * @param {string} directoryPath - The path to the directory.
 * @returns {Array<string>} List of file names.
 */
function getDirectoryFilesExcludingTemp(directoryPath) { // Define a helper function used by the export process.
    const tempExtensions = [".tmp", ".crdownload", ".part", ".download"]; // List of temporary file extensions
    try { // Start protected execution that may throw errors.
        return fs // Return the computed result for this execution path.
            .readdirSync(directoryPath) // Read all files in the directory
            .filter( // Execute this statement as part of the export workflow.
                (file) => // Execute this statement as part of the export workflow.
                    !tempExtensions.some((ext) => file.toLowerCase().endsWith(ext)) // Execute this statement as part of the export workflow.
            ); // Filter out files ending with temp extensions
    } catch (e) { // Execute this statement as part of the export workflow.
        console.error( // Write an error message to the console for diagnostics.
            `[UTIL] Error reading directory ${directoryPath}: ${e.message}` // Build a dynamic log or error string using runtime values.
        ); // Log directory read error
        return []; // Return the computed result for this execution path.
    } // Close the current block scope.
} // Close the current block scope.

/**
 * Polls the local file system until the download process has completed (no temporary files).
 * @param {string} directoryPath - The path to the download directory.
 * @param {number} timeoutMs - The maximum time to wait in milliseconds.
 * @returns {Promise<boolean>} Resolves true when no temp files are found.
 */
async function waitForDownloadCompletion(directoryPath, timeoutMs = 60000) { // Define an async function for this workflow step.
    const pollInterval = 1000; // Check every second
    const maxAttempts = Math.ceil(timeoutMs / pollInterval); // Calculate max checks
    let attempts = 0; // Initialize attempt counter
    const tempExtensions = [".tmp", ".crdownload", ".part"]; // Temporary extensions

    return new Promise((resolve, reject) => { // Return the computed result for this execution path.
        // Return a promise that polls
        const interval = setInterval(() => { // Declare a constant used in the current scope.
            // Start polling interval
            attempts++; // Execute this statement as part of the export workflow.

            try { // Start protected execution that may throw errors.
                // Check if any temporary download file exists
                const files = fs.readdirSync(directoryPath); // Read directory files
                const isDownloading = files.some((file) => // Declare a constant used in the current scope.
                    tempExtensions.some((ext) => file.toLowerCase().endsWith(ext)) // Execute this statement as part of the export workflow.
                ); // Check for temp extensions

                if (!isDownloading) { // Check this condition before continuing.
                    // If no temp files are found, download is complete
                    clearInterval(interval); // Stop polling
                    resolve(true); // Resolve the promise
                    return; // Return the computed result for this execution path.
                } // Close the current block scope.
            } catch (e) { // Execute this statement as part of the export workflow.
                // Handle file system errors during polling
                clearInterval(interval); // Stop polling
                reject( // Execute this statement as part of the export workflow.
                    new Error(`File system error during download wait: ${e.message}`) // Build a dynamic log or error string using runtime values.
                ); // Reject with error
                return; // Return the computed result for this execution path.
            } // Close the current block scope.

            if (attempts >= maxAttempts) { // Check this condition before continuing.
                // Check for timeout
                clearInterval(interval); // Stop polling
                reject( // Execute this statement as part of the export workflow.
                    new Error( // Execute this statement as part of the export workflow.
                        `File download did not complete within ${timeoutMs / 1000} seconds.` // Build a dynamic log or error string using runtime values.
                    ) // Close the current parenthesized expression.
                ); // Reject with timeout error
            } // Close the current block scope.
        }, pollInterval); // Set the polling frequency
    }); // Close the current block and complete the related call.
} // Close the current block scope.

/**
 * Gets the newest non-temporary file in a directory based on its modification time.
 * @param {string} directoryPath - The directory to check.
 * @returns {string|null} The filename of the newest non-temp file.
 */
function getNewestNonTempFile(directoryPath) { // Define a helper function used by the export process.
    try { // Start protected execution that may throw errors.
        const files = getDirectoryFilesExcludingTemp(directoryPath); // Use safe helper to get non-temp files
        if (files.length === 0) return null; // Return null if no files exist

        let newestFile = null; // Track the newest filename
        let newestTime = 0; // Track the newest modification time

        for (const file of files) { // Iterate through values in this collection or range.
            // Iterate through files
            const filePath = path.join(directoryPath, file); // Full path
            let stat; // Declare a mutable variable used in the current scope.
            try { // Start protected execution that may throw errors.
                stat = fs.statSync(filePath); // Get file statistics (including modification time)
            } catch (e) { // Execute this statement as part of the export workflow.
                console.warn(`[UTIL] Skipping file ${file}: ${e.message}`); // Skip if stat fails
                continue; // Skip to the next loop iteration.
            } // Close the current block scope.

            if (stat.mtimeMs > newestTime) { // Check this condition before continuing.
                // Check if current file is newer
                newestTime = stat.mtimeMs; // Update newest time
                newestFile = file; // Update newest file name
            } // Close the current block scope.
        } // Close the current block scope.
        return newestFile; // Return the newest file
    } catch (error) { // Execute this statement as part of the export workflow.
        console.error( // Write an error message to the console for diagnostics.
            `[UTIL] Error reading directory for newest file: ${error.message}` // Build a dynamic log or error string using runtime values.
        ); // Log error
        return null; // Return the computed result for this execution path.
    } // Close the current block scope.
} // Close the current block scope.

// EXPORT SCOPE UTILITY

/**
 * Recursively traverses a nested Table of Contents (TOC) structure
 * and collects all UUIDs and slugs for the full export scope.
 * @param {Array<Object>} tocArray - The array of TOC items.
 * @param {Array<Object>} scope - The current collection of UUID/slug objects.
 * @returns {Array<Object>} The complete list of objects for the export scope.
 */
function collectAllTOCItemsForExport(tocArray, scope = []) { // Define a helper function used by the export process.
    if (!Array.isArray(tocArray)) return scope; // Base case: return if not an array

    for (const item of tocArray) { // Iterate through values in this collection or range.
        // Iterate through items
        // Step 1: Add the current item's UUID and slug
        if (item.uuid && item.slug) { // Check this condition before continuing.
            // Check for required properties
            scope.push({ // Execute this statement as part of the export workflow.
                uuid: item.uuid, // Execute this statement as part of the export workflow.
                code_slug: item.slug, // Execute this statement as part of the export workflow.
            }); // Add the current item to the scope
        } // Close the current block scope.
        // Step 2: Recursively check for nested children
        if (item.children && Array.isArray(item.children)) { // Check this condition before continuing.
            collectAllTOCItemsForExport(item.children, scope); // Recurse into children
        } // Close the current block scope.
    } // Close the current block scope.
    return scope; // Return the accumulated scope list
} // Close the current block scope.

/**
 * Navigates a fresh client page to the API domain so browser-context fetch requests
 * are not sent from an about:blank origin.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @returns {Promise<void>}
 */
async function initializeClientPageSession(page) { // Define an async function for this workflow step.
    await page.goto(API_BASE_DOMAIN, { // Wait for this asynchronous operation to finish.
        waitUntil: "domcontentloaded", // Execute this statement as part of the export workflow.
        timeout: BROWSER_NAVIGATION_TIMEOUT_MS, // Execute this statement as part of the export workflow.
    }); // Close the current block and complete the related call.
} // Close the current block scope.

/**
 * Resolves the state folder slug for a client.
 * Falls back to region slug when no explicit state metadata exists.
 * @param {Object} clientData - Client metadata from the region API.
 * @param {string} regionSlug - Region fallback slug.
 * @param {string} clientSlug - Client slug fallback source.
 * @returns {string} Lowercase state slug for local folder routing.
 */
function resolveClientStateSlug(clientData, regionSlug, clientSlug) { // Define a helper function used by the export process.
    const slugMatch = // Declare a constant used in the current scope.
        typeof clientSlug === "string" // Execute this statement as part of the export workflow.
            ? clientSlug.match(/-([a-z]{2})$/i) // Execute this statement as part of the export workflow.
            : null; // Execute this statement as part of the export workflow.
    const slugDerivedState = slugMatch ? slugMatch[1] : null; // Declare a constant used in the current scope.

    const possibleValues = [ // Declare a constant used in the current scope.
        clientData?.state_slug, // Execute this statement as part of the export workflow.
        clientData?.state, // Execute this statement as part of the export workflow.
        clientData?.state_abbr, // Execute this statement as part of the export workflow.
        clientData?.region_slug, // Execute this statement as part of the export workflow.
        clientData?.region?.slug, // Execute this statement as part of the export workflow.
        slugDerivedState, // Execute this statement as part of the export workflow.
        regionSlug, // Execute this statement as part of the export workflow.
    ]; // Close the current array or bracketed expression.

    for (const value of possibleValues) { // Iterate through values in this collection or range.
        if (typeof value === "string" && value.trim()) { // Check this condition before continuing.
            return value.trim().toLowerCase(); // Return the computed result for this execution path.
        } // Close the current block scope.
    } // Close the current block scope.

    return "unknown-state"; // Return the computed result for this execution path.
} // Close the current block scope.

/**
 * Generates a random integer between 0 (inclusive) and 99 (inclusive).
 * This function is inclusive of 0 and inclusive of 99.
 * @returns {number} A random integer from 0 to 99.
 */
function generateRandomNumber() { // Define a helper function used by the export process.
    // Math.random() generates a float from [0, 1)
    // Multiplying by 100 gives a range of [0, 100)
    // Math.floor() rounds down, resulting in an integer from [0, 99].
    return Math.floor(Math.random() * 100); // Return the computed result for this execution path.
} // Close the current block scope.

// EXECUTION

// Call the main function and handle any top-level errors
executeCodeExportProcess().catch((err) => { // Execute this statement as part of the export workflow.
    console.error("Fatal error outside main execution block:", err); // Catch and log any unhandled promise rejection
    process.exit(1); // Exit with error code
}); // Close the current block and complete the related call.

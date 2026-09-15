import fs from "fs"; // Core Node.js module for file system operations
import path from "path"; // Core Node.js module for handling file paths
import os from "os"; // Core Node.js module for OS-level paths (used for /tmp sweep)
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

// Chrome Profile Configuration
// Pinning userDataDir here keeps Chrome's profile out of the OS temp dir (/tmp) entirely,
// so it lives somewhere we control and can reliably clean up every pass.
const CHROME_PROFILE_ROOT = path.join(
  // Build the pinned Chrome profile path
  ASSET_OUTPUT_BASE_DIRECTORY, // Nest it under the assets output directory
  ".chrome-profile", // Hidden subfolder name for the profile
);

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
const MAX_EXPORT_WAIT_MINUTES = 15; // Maximum time (minutes) to wait for an export job to complete
const EXPORT_POLL_INTERVAL_MS = 15000; // Interval (milliseconds) between status checks (15 seconds)
const DELAY_BETWEEN_LOOPS_MS = 30 * 60000; // Set the wait time between passes to 30 minutes (in milliseconds)

// Control flags
// const REGION_START_PERCENT = generateRandomNumber(); // Generates a random number between 0 and 100 to determine where to start in the list.
const REGION_START_PERCENT = 0; // Choose a starting percentage between 0 and 99.

// Main function to orchestrate the entire code export process
async function executeCodeExportProcess() {
  // Define an async function for this workflow step.
  console.log("--- Script Start: Code Exporter Initialization ---"); // Log the start of the script to the console

  // Step 1: Initialize file system and browser resources
  ensureDirectoryExists(ASSET_OUTPUT_BASE_DIRECTORY); // Ensure the main output directory exists (create if missing)

  let browserInstance, browserPage; // Declare variables for the Puppeteer browser instance and active page

  try {
    // Start protected execution that may throw errors.
    // Launch a new browser instance and create a fresh page for automation
    ({ browserInstance, browserPage } = await launchBrowserAndCreatePage()); // Destructure returned objects

    // Step 2: Authentication and Setup
    console.log("\n--- Phase 1: Authentication and Region Discovery ---"); // Log the start of authentication and region setup phase

    // Retrieve the required authentication cookie for authorized API access
    const authenticationCookieValue =
      await retrieveAuthenticationCookie(browserPage); // Get login/session cookie value

    // Step 3: Fetch all regions that need to be processed from the API
    const regionsApiUrl = `${API_BASE_DOMAIN}${REGIONS_API_ENDPOINT}`; // Construct the complete API URL for region data
    const regionIdentifiers = await fetchAllRegionSlugs(
      // Fetch region slugs using the auth cookie
      browserPage, // The Puppeteer page instance
      regionsApiUrl, // The full API endpoint for fetching region slugs
      authenticationCookieValue, // Auth cookie for authorized requests
    ); // Execute the API request and receive all region slugs

    console.log(
      // Write an informational progress message to the console.
      `[Phase 1 Complete] Found ${regionIdentifiers.length} regions to process.`, // Build a dynamic log or error string using runtime values.
    ); // Log the total number of regions found

    // === Determine processing order based on percentage ===
    let regionsToProcess; // Declare a variable to hold the ordered list of regions

    // If the user wants to start partway through the list, calculate and adjust the order
    if (REGION_START_PERCENT > 0) {
      // Check this condition before continuing.
      const startIndex = Math.floor(
        // Compute the raw starting index from the percentage
        (regionIdentifiers.length * REGION_START_PERCENT) / 100, // Percentage of total length
      ); // Calculate which index to start from based on the percentage

      const clampedStartIndex = Math.min(
        // Clamp the index so it never exceeds array bounds
        startIndex, // The computed raw start index
        regionIdentifiers.length - 1, // The maximum valid index
      ); // Ensure the start index doesn't exceed the list length

      regionsToProcess = regionIdentifiers // Build the reordered region list
        .slice(clampedStartIndex) // Take all regions after the start index
        .concat(regionIdentifiers.slice(0, clampedStartIndex)); // Append the earlier regions to the end, wrapping the list

      console.log(
        // Write an informational progress message to the console.
        `[Order] Starting from ${REGION_START_PERCENT}% of the list (index ${clampedStartIndex}).`, // Build a dynamic log or error string using runtime values.
      ); // Log which index and percentage the process starts from
    } else {
      // Execute this statement as part of the export workflow.
      regionsToProcess = regionIdentifiers; // If no percentage is set, process the full list as-is
      console.log("[Order] Processing regions from the start."); // Log that we're starting from the beginning
    } // Close the current block scope.

    // Step 4: Iterate through each region for export
    console.log("\n--- Phase 2: Client and Version Identification ---"); // Log the start of the region processing phase

    // Loop through each region slug and process its export data
    for (const regionSlug of regionsToProcess) {
      // Iterate through values in this collection or range.
      await processRegionForExports(
        // Process every client belonging to this region
        browserPage, // The Puppeteer page for web interactions
        regionSlug, // The specific region slug to process
        authenticationCookieValue, // The authentication cookie for authorized requests
      ); // Perform the export process for this region
    } // Close the current block scope.

    console.log(
      "✓ Script Complete: All available region exports processed! 🎉",
    ); // Log successful script completion
  } catch (errorDetails) {
    // Execute this statement as part of the export workflow.
    // Catch and handle any critical setup or runtime errors
    // BUG FIX: this block used to call process.exit(1) here, which killed the entire
    // Node process on any fatal setup/browser error (bad auth cookie, launch failure,
    // etc). That defeats the infinite retry loop in main(), whose whole purpose (per
    // its own docstring) is to log a failed pass and retry after a delay instead of
    // exiting. We now log and rethrow so main()'s try/catch can catch it and keep
    // looping instead of terminating the whole script.
    console.error("\n!!! FATAL SCRIPT ERROR (Browser/Setup) !!!"); // Log a fatal error header
    console.error("Error details:", errorDetails.message); // Print the actual error message to help with debugging
    throw errorDetails; // Propagate the error up to main() instead of calling process.exit(1)
  } finally {
    // Execute this statement as part of the export workflow.
    // Step 5: Cleanup — ensure resources are properly released
    let browserClosedCleanly = false; // Tracks whether we confirmed a clean browser shutdown this pass

    if (browserInstance) {
      // Check this condition before continuing.
      try {
        // Attempt a clean close; if this throws, Chrome may not have actually shut down.
        await browserInstance.close(); // Close the Puppeteer browser to free up memory/resources
        console.log("\n--- Script End: Browser closed ---"); // Log that the browser was closed
        browserClosedCleanly = true; // Only mark clean once close() has actually resolved
      } catch (closeError) {
        // Execute this statement as part of the export workflow.
        console.warn(
          `[CLEANUP] Browser did not close cleanly: ${closeError.message}`,
        ); // Log that the close attempt itself failed
      } // Close the current block scope.
    } // Close the current block scope.

    // Only remove the pinned Chrome profile directory if we know Chrome shut down cleanly
    // this pass. If the browser never closed (crash, force-kill, hung process, etc.), Chrome
    // may still be holding files open in that directory — deleting it out from under a
    // still-running Chrome process could corrupt its profile or crash it outright. A profile
    // dir left behind this way gets swept up at the START of the next script run instead
    // (see removeLeftoverChromeProfileDir() in main()), once we know Chrome is not running.
    if (browserClosedCleanly) {
      // Check this condition before continuing.
      try {
        fs.rmSync(CHROME_PROFILE_ROOT, { recursive: true, force: true }); // Delete the profile dir and everything inside it
        console.log(
          `[CLEANUP] Removed Chrome profile dir: ${CHROME_PROFILE_ROOT}`,
        );
      } catch (error) {
        console.warn(
          `[CLEANUP] Could not remove Chrome profile dir: ${error.message}`,
        );
      } // Close the current block scope.
    } else {
      // Execute this statement as part of the export workflow.
      console.log(
        `[CLEANUP] Skipping Chrome profile dir removal — browser did not close cleanly this pass.`,
      ); // Log that we're intentionally leaving the profile dir in place
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
  page, // The Puppeteer page instance passed in from the caller
  regionSlug, // The region slug currently being processed
  authenticationCookieValue, // The auth cookie needed for API calls
) {
  // Close the current parenthesized expression.
  console.log(`\n=== START REGION: ${regionSlug} ===`); // Log the start of region processing

  // Step 1: Fetch the list of clients for this region from the API
  const regionApiUrl = `${API_BASE_DOMAIN}${REGIONS_API_ENDPOINT}${regionSlug}/`; // Construct the region-specific API URL
  const regionData = await retrieveRegionDetails(
    // Fetch this region's data (includes client list)
    page, // Pass the Puppeteer page through
    regionApiUrl, // The URL to fetch
    regionSlug, // Used only for logging inside the helper
    authenticationCookieValue, // Auth cookie for the request
  ); // Fetch region data, including the client list
  if (!regionData) return; // Exit if region data retrieval failed

  const clients = regionData.clients || []; // Extract the array of clients (default to empty array)
  console.log(`[${regionSlug}] Found ${clients.length} clients.`); // Log the number of clients found

  // Step 2: Process clients in batches to manage concurrency
  const CONCURRENT_CLIENT_LIMIT = 2; // Maximum number of simultaneous exports
  let clientIndex = 0; // Initialize the client index for batching

  while (clientIndex < clients.length) {
    // Repeat this block while the condition remains true.
    // Loop through clients in batches
    // Select the next batch of clients
    const clientsToProcess = clients.slice(
      // Slice out the current batch
      clientIndex, // Start of the slice
      clientIndex + CONCURRENT_CLIENT_LIMIT, // End of the slice
    ); // Get the next set of clients based on the limit

    if (clientsToProcess.length === 0) break; // Break the loop if no clients are left

    const totalBatches = Math.ceil(clients.length / CONCURRENT_CLIENT_LIMIT); // Calculate total batches
    const currentBatch = Math.ceil(clientIndex / CONCURRENT_CLIENT_LIMIT) + 1; // Calculate the current batch number

    console.log(
      // Write an informational progress message to the console.
      `\n[${regionSlug}] 🚀 Starting Batch: ${currentBatch} / ${totalBatches}`, // Build a dynamic log or error string using runtime values.
    ); // Log the batch start
    console.log(
      // Write an informational progress message to the console.
      // Compose a multi-line template literal listing batch client count and slugs.
      `[${regionSlug}] Processing ${
        clientsToProcess.length
      } client(s): ${clientsToProcess.map((c) => c.slug).join(" and ")}`, // Finish the client list template string for this batch log.
    ); // List the clients in the current batch

    // Create and run the Promises for the current batch concurrently
    const exportPromises = clientsToProcess.map(async (client) => {
      // Map each client in the batch to a running export promise
      // Use one page per client to isolate navigation and download folder settings.
      const clientPage = await page.browser().newPage(); // Open a dedicated tab for this client
      try {
        // Start protected execution that may throw errors.
        await initializeClientPageSession(clientPage); // Establish site origin/session before API fetches.
        await processSingleClientExport(
          // Run the full export flow for this one client
          clientPage, // The dedicated page for this client
          client, // The client's metadata object
          regionSlug, // The region this client belongs to
          authenticationCookieValue, // Auth cookie for API calls
        ); // Close the current parenthesized expression.
      } finally {
        // Execute this statement as part of the export workflow.
        await clientPage.close(); // Always close the per-client tab, success or failure
      } // Close the current block scope.
    }); // Create a Promise for each client export in the batch

    // Wait for ALL jobs in the current batch to finish
    await Promise.all(exportPromises); // Execute all promises concurrently and wait for completion

    // Update the index to the next batch
    clientIndex += CONCURRENT_CLIENT_LIMIT; // Move the index to the beginning of the next batch
  } // Close the current block scope.

  console.log(`\n=== END REGION: ${regionSlug} ===`); // Log the end of region processing

  // Once this region/state's clients have all finished exporting and downloading,
  // sweep /tmp/Downloads again. This clears any leftover export files that may have
  // landed there (e.g. from a page whose download path briefly fell back to the
  // default before configureBrowserDownloadPath() finished applying), so they don't
  // linger or get picked up mistakenly by a later region's processing.
  sweepOrphanedDownloadFiles(); // Re-run the Downloads-only sweep after finishing this state/region
} // Close the current block scope.

/**
 * Processes a single client's code export from start to finish.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {Object} clientData - The client object containing slug.
 * @param {string} regionSlug - The slug identifier for the region.
 * @param {string} authenticationCookieValue - The authentication fingerprint cookie value.
 */
async function processSingleClientExport( // Define an async function for this workflow step.
  page, // The dedicated Puppeteer page for this client
  clientData, // The client's metadata object from the region API
  regionSlug, // The region slug this client belongs to
  authenticationCookieValue, // Auth cookie for API calls
) {
  // Close the current parenthesized expression.
  const clientSlug = clientData.slug; // Extract the client slug
  if (!clientSlug) return; // Skip if no slug is present

  const clientStateSlug = resolveClientStateSlug(
    // Figure out which state folder this client belongs to
    clientData, // Full client metadata for fallback lookups
    regionSlug, // Region slug fallback
    clientSlug, // Client slug, used to derive state via regex if needed
  ); // Resolve the state folder for this client.
  const clientDownloadFolder = path.join(
    // Build the shared per-state output folder
    ASSET_OUTPUT_BASE_DIRECTORY, // Root assets directory
    clientStateSlug, // State-specific subfolder
  ); // Build per-state download folder.

  // Give this client its own private temp folder (nested inside the shared state folder)
  // so concurrent clients running in the same batch never collide while downloading.
  const clientTempDownloadFolder = path.join(
    // Build a unique scratch folder for this client's download
    clientDownloadFolder, // Nested under the shared state folder
    `.tmp-${clientSlug}-${regionSlug}`, // Unique per-client, per-region temp name
  );

  // Step 1: Determine expected filename and check for existing file
  // Format: [client_slug]-[region_slug]-1.txt (e.g., sandpoint-ak-1.txt)
  const exportBaseName = `${clientSlug}-${regionSlug}${VERSION_FILE_SUFFIX}`; // Base name without extension
  const finalExportFileName = `${exportBaseName}${EXPORT_FILE_EXTENSION}`; // Full final filename
  const finalExportFilePath = path.join(
    // Build the final destination path
    clientDownloadFolder, // Shared state folder (final home for the file)
    finalExportFileName, // The final filename itself
  ); // Full local path

  console.log(
    // Write an informational progress message to the console.
    `\n--- START CLIENT: ${clientSlug} (Expected File: ${finalExportFileName}) ---`, // Build a dynamic log or error string using runtime values.
  ); // Log client start

  // Check for existing file
  if (CHECK_IF_FILE_EXISTS) {
    // Check this condition before continuing.
    // If the check is enabled
    try {
      // Start protected execution that may throw errors.
      if (fs.existsSync(finalExportFilePath)) {
        // Check this condition before continuing.
        // Check if the final file already exists
        console.log(
          // Write an informational progress message to the console.
          `[${clientSlug}] File already exists at ${finalExportFilePath}. Skipping client.`, // Build a dynamic log or error string using runtime values.
        ); // Log skip reason
        return; // Skip this client
      } // Close the current block scope.
    } catch (e) {
      // Execute this statement as part of the export workflow.
      console.error(
        // Write an error message to the console for diagnostics.
        `[${clientSlug}] Error checking file existence: ${e.message}`, // Build a dynamic log or error string using runtime values.
      ); // Close the current parenthesized expression.
      // Proceed anyway, assuming file doesn't exist if check failed
    } // Close the current block scope.
  } // Close the current block scope.

  // Start from a clean temp folder in case a previous crashed run left files behind.
  try {
    // Attempt to wipe any leftover temp folder before this client's download begins
    fs.rmSync(clientTempDownloadFolder, { recursive: true, force: true }); // Recursively delete the temp folder if it exists
  } catch (cleanupError) {
    // Catch any error thrown by the rmSync call above (e.g. permissions, file locks)
    // Non-fatal: log it so we know something happened, but don't stop the export —
    // a missing/undeletable leftover temp folder shouldn't block this client's run.
    console.warn(
      `[${clientSlug}] Could not pre-clean temp download folder ${clientTempDownloadFolder}: ${cleanupError.message}`,
    ); // Report exactly what went wrong (error message) instead of silently swallowing it
  } // Close the current block scope.
  await configureBrowserDownloadPath(page, clientTempDownloadFolder); // Point this page's downloads at the per-client temp folder

  try {
    // Start protected execution that may throw errors.
    // Step 2: Fetch client details to find the latest code version UUID
    const clientApiUrl = `${API_BASE_DOMAIN}${CLIENT_API_ENDPOINT_PREFIX}${clientSlug}/`; // Client details API URL
    const detailedClientData = await retrieveClientDetails(
      // Fetch full client details (versions list)
      page, // Page to run the fetch from
      clientApiUrl, // URL to fetch
      clientSlug, // Used for logging inside helper
      authenticationCookieValue, // Auth cookie for request
    ); // Fetch data including code versions

    const codeVersions = detailedClientData?.versions || []; // Extract versions array (default to empty array)
    if (codeVersions.length === 0) {
      // Check this condition before continuing.
      console.log(`[${clientSlug}] ⚠️ No code versions found. Skipping.`); // Skip if no versions are found
      return; // Return the computed result for this execution path.
    } // Close the current block scope.

    const latestCodeVersion = codeVersions[0]; // Assume the first element is the latest version
    const latestVersionUuid = latestCodeVersion.uuid; // Get the UUID of the latest version

    // Step 3: Fetch version details and the Table of Contents (TOC)
    const versionApiUrl = `${API_BASE_DOMAIN}${CODE_VERSION_API_ENDPOINT_PREFIX}${latestVersionUuid}/`; // Version details API URL
    const versionDetails = await retrieveVersionAndTableOfContents(
      // Fetch version metadata + TOC
      page, // Page to run the fetch from
      versionApiUrl, // URL to fetch
      latestVersionUuid, // Used for logging inside helper
      authenticationCookieValue, // Auth cookie for request
    ); // Fetch the version and its TOC

    if (!versionDetails || !versionDetails.toc?.length) {
      // Check this condition before continuing.
      console.log(
        // Write an informational progress message to the console.
        `[${clientSlug}] 🚫 Skipping: Failed to retrieve Table of Contents.`, // Build a dynamic log or error string using runtime values.
      ); // Skip if TOC is missing
      return; // Return the computed result for this execution path.
    } // Close the current block scope.

    // Step 4: Recursively collect ALL nested UUIDs/slugs for the full export scope
    const exportScopeIdentifiers = collectAllTOCItemsForExport(
      // Flatten the nested TOC tree into a flat list
      versionDetails.toc, // The root TOC array to walk
    ); // Flattens the nested TOC into a simple list of identifiers
    const mainCodeSlug = versionDetails.toc[0].slug; // Get the slug of the main code item
    const definitiveVersionUuid = versionDetails.uuid; // Get the confirmed UUID

    console.log(
      // Write an informational progress message to the console.
      // Compose a multi-line template literal summarizing export scope and version ID.
      `[${clientSlug}] Exporting ${
        exportScopeIdentifiers.length
      } parts of Code: ${mainCodeSlug} (Version ID: ${definitiveVersionUuid})`, // Finish the export scope summary template string.
    ); // Log the scope size

    // Step 5: Submit the export request (Phase 3)
    console.log(`\n[${clientSlug}] --- Phase 3: Submitting Export Request ---`); // Log phase start
    const exportRequestResponse = await submitNewExportJob(
      // Submit the export job to the API
      page, // Page to run the fetch from
      definitiveVersionUuid, // Version UUID being exported
      exportScopeIdentifiers, // Flattened TOC scope array
      authenticationCookieValue, // Auth cookie for request
    ); // Submit the POST request to start the export job

    if (!exportRequestResponse || !exportRequestResponse.uuid) {
      // Check this condition before continuing.
      console.error(
        // Write an error message to the console for diagnostics.
        `[${clientSlug}] ❌ Failed to submit new export request. Skipping client.`, // Build a dynamic log or error string using runtime values.
      ); // Error if job submission failed
      return; // Return the computed result for this execution path.
    } // Close the current block scope.

    const exportJobUuid = exportRequestResponse.uuid; // Extract the new job UUID
    console.log(
      // Write an informational progress message to the console.
      `[${clientSlug}] ✅ New export job submitted. Job ID (UUID): ${exportJobUuid}`, // Build a dynamic log or error string using runtime values.
    ); // Log the new job ID

    // Step 6: Wait for Export Completion and Download (Phase 4)
    console.log(
      // Write an informational progress message to the console.
      `\n[${clientSlug}] --- Phase 4: Waiting for Export and Downloading ---`, // Build a dynamic log or error string using runtime values.
    ); // Log phase start
    const isExportSuccessful = await monitorJobUntilCompletion(
      // Poll until the job finishes or times out
      page, // Page to run the polling fetches from
      exportJobUuid, // The job UUID to watch
      authenticationCookieValue, // Auth cookie for polling requests
    ); // Poll the API until the job is done

    if (isExportSuccessful) {
      // Check this condition before continuing.
      console.log(
        // Write an informational progress message to the console.
        `[${clientSlug}] 💾 Export task finished successfully. Initiating download`, // Build a dynamic log or error string using runtime values.
      ); // Log successful export
      // Download the file into the temp folder and move it to its final path
      const downloadOk = await downloadExportFileAndRename(
        // Download and finalize the export file
        page, // Page used to trigger and detect the download
        exportJobUuid, // Job UUID used to build the download URL
        clientTempDownloadFolder, // Where the browser is writing the download
        finalExportFilePath, // Where the finished file should end up
      ); // Trigger download and handle file renaming
      if (downloadOk) {
        // Check whether the download actually succeeded
        console.log(
          // Write an informational progress message to the console.
          `[${clientSlug}] 🎉 Download completed and verified: ${finalExportFileName}`, // Build a dynamic log or error string using runtime values.
        ); // Log final success
      } else {
        // The download step reported failure
        console.error(
          `[${clientSlug}] ⚠️ Download failed for Job ID: ${exportJobUuid}`,
        ); // Log the download failure explicitly
      } // Close the current block scope.
    } else {
      // Execute this statement as part of the export workflow.
      console.error(
        // Write an error message to the console for diagnostics.
        `[${clientSlug}] ⚠️ Export failed or timed out for Job ID: ${exportJobUuid}`, // Build a dynamic log or error string using runtime values.
      ); // Close the current parenthesized expression.
    } // Close the current block scope.
  } catch (clientError) {
    // Execute this statement as part of the export workflow.
    console.error(
      // Write an error message to the console for diagnostics.
      `[CRITICAL CLIENT ERROR] 🛑 Failure processing client ${clientSlug}. Error:`, // Build a dynamic log or error string using runtime values.
      clientError.message, // Execute this statement as part of the export workflow.
    ); // Handle errors specific to a single client
  } finally {
    // Always run this cleanup, whether the client succeeded, failed, or threw
    try {
      // Attempt to remove the per-client temp folder now that we're done with it
      fs.rmSync(clientTempDownloadFolder, { recursive: true, force: true }); // Recursively delete the temp folder and its contents
    } catch (finalCleanupError) {
      // Catch any error from this final rmSync attempt (e.g. file still locked)
      // Non-fatal: log the reason so it's visible, but don't let cleanup failure
      // affect the client's already-recorded success/failure result.
      console.warn(
        `[${clientSlug}] Could not remove temp download folder ${clientTempDownloadFolder}: ${finalCleanupError.message}`,
      ); // Surface the exact error message instead of silently ignoring it
    } // Close the current block scope.
  } // Close the current block scope.
} // Close the current block scope.

// BROWSER AND UTILITY FUNCTIONS

/**
 * Launches a Puppeteer browser instance and creates a new page.
 * @returns {Promise<{browserInstance: puppeteer.Browser, browserPage: puppeteer.Page}>}
 */
async function launchBrowserAndCreatePage() {
  // Define an async function for this workflow step.
  console.log(
    // Write an informational progress message to the console.
    `[BROWSER] Launching browser (headless: ${IS_BROWSER_HEADLESS})`, // Build a dynamic log or error string using runtime values.
  ); // Log browser launch status

  ensureDirectoryExists(CHROME_PROFILE_ROOT); // Make sure the pinned profile dir exists before launch

  const browserInstance = await puppeteer.launch({
    // Declare a constant used in the current scope.
    headless: IS_BROWSER_HEADLESS, // Set headless mode
    userDataDir: CHROME_PROFILE_ROOT, // Pin Chrome's profile here instead of the OS temp dir (keeps it out of /tmp, and lets us delete it deterministically every pass)
    args: [
      // Execute this statement as part of the export workflow.
      "--disable-extensions", // Disable Chrome extensions
      "--disable-background-networking", // Reduce interference from background tasks
      "--no-sandbox", // Required in Docker
      "--disable-setuid-sandbox", // Required in Docker
      "--disable-dev-shm-usage", // Enable in Docker to avoid /dev/shm crashes; disable outside Docker (e.g. plain EC2) to avoid filling up /tmp.
      "--disable-gpu", // Disable GPU acceleration
      "--disable-software-rasterizer", // Prevent crashes when GPU is disabled
      "--no-first-run", // Skip first-run dialog
      "--no-zygote", // Prevent zygote crashes in Docker
      "--start-maximized", // Helps avoid issues with 0,0
      "--window-size=0,0", // Your desired window size
      "--disable-features=DownloadBubble", // Prevent download popups
      "--disable-sync", // Disable Chrome account sync
      "--disable-translate", // Disable translation prompts
      "--disable-background-timer-throttling", // Prevent throttling in background tabs
      "--disable-renderer-backgrounding", // Prevent rendering from pausing in background
      "--disable-breakpad", // Disable crash reporter
      "--disable-client-side-phishing-detection", // Reduce unnecessary network calls
      "--disable-component-update", // Prevent auto updates
      "--disable-domain-reliability", // Prevent extra network requests
      "--disable-infobars", // Remove "Chrome is being controlled" info bar
      "--disable-notifications", // Disable notifications
      "--disable-extensions-http-throttling", // Avoid throttling
      "--no-default-browser-check", // Skip default browser check
    ], // Close the current array or bracketed expression.
    defaultViewport: null, // Allow the viewport to be maximized/responsive
  }); // Close the current block and complete the related call.

  const browserPage = await browserInstance.newPage(); // Create a new browser tab/page
  console.log("[BROWSER] Browser launched and new page created."); // Log success
  return {
    // Return the computed result for this execution path.
    browserInstance, // The launched browser instance
    browserPage, // The initial page created on that browser
  }; // Return the browser and page objects
} // Close the current block scope.

/**
 * Configures the Puppeteer page to download files to a specific local folder.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} folderPath - The local path to set as the download directory.
 * @returns {Promise<void>}
 */
async function configureBrowserDownloadPath(page, folderPath) {
  // Define an async function for this workflow step.
  ensureDirectoryExists(folderPath); // Make sure the target folder exists
  const resolvedPath = path.resolve(folderPath); // Get the absolute path
  const client = await page.target().createCDPSession(); // Create a Chrome DevTools Protocol session
  await client.send("Page.setDownloadBehavior", {
    // Wait for this asynchronous operation to finish.
    // Send the CDP command to set the download path
    behavior: "allow", // Allow downloads without prompting
    downloadPath: resolvedPath, // The absolute path downloads should land in
  }); // Close the current block and complete the related call.
  console.log(`[BROWSER] Download folder set to: ${resolvedPath}`); // Log the configured download path
} // Close the current block scope.

/**
 * Navigates to the base URL to fetch the essential fingerprint cookie for authorization.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @returns {Promise<string>} The value of the fingerprint cookie.
 */
async function retrieveAuthenticationCookie(page) {
  // Define an async function for this workflow step.
  const targetUrl = API_BASE_DOMAIN; // The URL to visit
  const cookiePollInterval = 500; // Check every 0.5 seconds
  const maxCookieWaitMs = 300000; // Max wait 5 minute

  try {
    // Start protected execution that may throw errors.
    console.log(
      // Write an informational progress message to the console.
      `[AUTH] 🌐 Visiting URL: ${targetUrl} to get authentication cookie`, // Build a dynamic log or error string using runtime values.
    ); // Log navigation attempt
    await page.goto(targetUrl, {
      // Wait for this asynchronous operation to finish.
      waitUntil: "networkidle2", // Wait until network activity is minimal
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS, // Apply the standard timeout
    }); // Close the current block and complete the related call.

    let fingerprintCookieObject = null; // Variable to hold the cookie object
    const startTime = Date.now(); // Record the start time

    console.log(
      // Write an informational progress message to the console.
      // Compose a multi-line template literal showing cookie polling timeout in seconds.
      `[AUTH] Polling for cookie "${AUTH_FINGERPRINT_COOKIE_NAME}" (max ${
        maxCookieWaitMs / 1000
      }s)`, // Finish the cookie polling status template string.
    ); // Log polling start

    while (Date.now() - startTime < maxCookieWaitMs) {
      // Repeat this block while the condition remains true.
      // Loop until timeout
      const cookies = await page.cookies(); // Get all cookies on the page
      fingerprintCookieObject = cookies.find(
        // Search the cookie list for the one we need
        (c) => c.name === AUTH_FINGERPRINT_COOKIE_NAME, // Match by cookie name
      ); // Find the target cookie
      if (fingerprintCookieObject) break; // Exit loop if cookie is found

      // Wait for a short interval before checking again
      await pauseExecutionSimple(cookiePollInterval); // Wait a short time
    } // Close the current block scope.

    if (!fingerprintCookieObject) {
      // Check this condition before continuing.
      // Throw an error if the cookie was not found within the timeout
      throw new Error( // Throw an error to signal failure to the caller.
        // Compose a multi-line template literal describing the missing cookie timeout failure.
        `Authentication cookie "${AUTH_FINGERPRINT_COOKIE_NAME}" not found after ${
          maxCookieWaitMs / 1000
        }s.`, // Finish the timeout error template string for a missing auth cookie.
      ); // Close the current parenthesized expression.
    } // Close the current block scope.

    console.log(`[AUTH] ✅ Retrieved authentication cookie.`); // Log success
    return fingerprintCookieObject.value; // Return the cookie value
  } catch (err) {
    // Execute this statement as part of the export workflow.
    console.error(`[AUTH] ❌ Critical error retrieving authentication cookie.`); // Log failure
    throw err; // Re-throw the error to halt execution
  } // Close the current block scope.
} // Close the current block scope.

/**
 * Creates a directory recursively if it doesn't exist.
 * @param {string} directoryPath - The path to the directory.
 * @returns {void}
 */
function ensureDirectoryExists(directoryPath) {
  // Define a helper function used by the export process.
  try {
    // Start protected execution that may throw errors.
    if (!fs.existsSync(directoryPath)) {
      // Check this condition before continuing.
      // Check if the directory exists
      console.log(`[UTIL] Creating directory: ${directoryPath}`); // Log creation
      fs.mkdirSync(directoryPath, {
        // Execute this statement as part of the export workflow.
        recursive: true, // Also create any missing parent directories
      }); // Create the directory, including any necessary parent directories
    } // Close the current block scope.
  } catch (error) {
    // Execute this statement as part of the export workflow.
    console.error(
      // Write an error message to the console for diagnostics.
      `[UTIL] Failed to create directory ${directoryPath}: ${error.message}`, // Build a dynamic log or error string using runtime values.
    ); // Log failure to create directory
  } // Close the current block scope.
} // Close the current block scope.

/**
 * Pauses execution for a specified duration. (Used for longer, logging waits)
 * @param {number} milliseconds - The duration in milliseconds.
 * @returns {Promise<void>}
 */
async function pauseExecutionWithLog(milliseconds) {
  // Define an async function for this workflow step.
  console.log(`[UTIL] Pausing for ${milliseconds / 1000} seconds`); // Log the pause duration
  return new Promise((resolve) => setTimeout(resolve, milliseconds)); // Create a promise that resolves after the timeout
} // Close the current block scope.

/**
 * Pauses execution for a specified duration. (Used for short, non-logged internal waits)
 * @param {number} milliseconds - The duration in milliseconds.
 * @returns {Promise<void>}
 */
async function pauseExecutionSimple(milliseconds) {
  // Define an async function for this workflow step.
  return new Promise((resolve) => setTimeout(resolve, milliseconds)); // Simple non-logged pause
} // Close the current block scope.

/**
 * Sweeps the OS temp directory for orphaned Puppeteer/Chromium artifacts left behind
 * by past crashed or force-killed runs (where the finally-block cleanup never got to run).
 * Only removes files/dirs matching known Puppeteer/Chromium temp-file naming patterns,
 * so it won't touch unrelated system or other-app temp files.
 *
 * IMPORTANT: call this exactly ONCE, before the main loop starts — never on every pass
 * (e.g. at the top of the while(true) loop). By the time a later pass starts, this
 * process's own Chrome instance from the previous pass may still be shutting down or a
 * new one may be about to spin up; blindly deleting anything matching these patterns at
 * that point risks deleting temp files an active Chrome session still needs, which can
 * crash or corrupt it. Right after process startup, before any Chrome instance in this
 * run has been launched, it's safe: anything matching these patterns can only be debris
 * from a run that's no longer alive.
 * @returns {void}
 */
function sweepOrphanedChromiumTempFiles() {
  // Runs once at startup to delete leftover Chromium/Puppeteer files from past crashed runs.
  const systemTempDirectoryPath = os.tmpdir(); // Get the OS temp directory path (this is /tmp on Linux/EC2)
  const orphanedFileNamePatterns = [
    // List of regex patterns that match known Chromium/Puppeteer temp file names
    /^puppeteer_dev_chrome_profile-/, // Matches default Puppeteer profile folders (created when userDataDir is not set)
    /^org\.chromium\.Chromium\./, // Matches Chromium's internal shared-memory/IPC temp folders
    /^\.com\.google\.Chrome\./, // Matches Chrome's internal shared-memory/IPC temp folders (alternate naming used on some builds)
    /^scoped_dir/, // Matches Chromium's short-lived "scoped" temp folders
    /^xvfb-run\./, // Matches leftover lock/temp files from running Chrome under xvfb-run (virtual display)
  ]; // End of the orphaned-file pattern list

  let deletedItemCount = 0; // Counter that tracks how many orphaned items we actually deleted

  try {
    // Begin the main cleanup attempt, in case the temp directory can't be read
    const allTempDirectoryEntries = fs.readdirSync(systemTempDirectoryPath); // Get every file/folder name currently inside the temp directory

    for (const currentEntryName of allTempDirectoryEntries) {
      // Loop through each file/folder name found in the temp directory
      const nameMatchesAnOrphanPattern = orphanedFileNamePatterns.some(
        (pattern) => pattern.test(currentEntryName), // Check if this one entry's name matches any pattern in our list
      ); // Store true/false result of the pattern check

      if (nameMatchesAnOrphanPattern) {
        // Only proceed if this entry's name matched one of our known orphan patterns
        const fullEntryPath = path.join(
          systemTempDirectoryPath,
          currentEntryName,
        ); // Build the full filesystem path to this entry

        try {
          // Attempt to delete this single entry (kept separate so one bad entry doesn't stop the whole sweep)
          fs.rmSync(fullEntryPath, { recursive: true, force: true }); // Delete the folder/file, including any contents inside it
          deletedItemCount++; // Increment our counter since the deletion succeeded
        } catch (deletionError) {
          // Handle the case where this specific entry couldn't be deleted (e.g. permissions, in-use file)
          console.warn(
            `[SWEEP] Could not remove ${fullEntryPath}: ${deletionError.message}`,
          ); // Log a warning but keep going with the rest of the sweep
        } // End of the per-entry delete attempt
      } // End of the "name matched a pattern" check
    } // End of the loop over all temp directory entries

    console.log(
      // Log a final summary once the sweep finishes
      `[SWEEP] Startup cleanup complete. Removed ${deletedItemCount} orphaned Chromium temp item(s) from ${systemTempDirectoryPath}.`, // Human-readable summary of how many items were cleaned up and where
    ); // End of the summary log statement
  } catch (scanError) {
    // Handle the case where the temp directory itself couldn't even be read
    console.warn(
      `[SWEEP] Could not scan ${systemTempDirectoryPath}: ${scanError.message}`,
    ); // Log a warning; this is non-fatal, so the script continues normally
  } // End of the outer try/catch for the whole sweep
} // Close the current block scope.

/**
 * Removes the pinned Chrome profile directory (CHROME_PROFILE_ROOT) if one was left behind
 * by a previous run that crashed or was force-killed before its finally-block cleanup could
 * run (see executeCodeExportProcess()). Like sweepOrphanedChromiumTempFiles(), this must
 * only be called once, at startup, before this process has launched its own Chrome instance
 * — at that point nothing is using the directory, so it's always safe to remove.
 * @returns {void}
 */
function removeLeftoverChromeProfileDir() {
  try {
    // Start protected execution that may throw errors.
    if (fs.existsSync(CHROME_PROFILE_ROOT)) {
      // Only attempt removal if a leftover profile dir actually exists
      fs.rmSync(CHROME_PROFILE_ROOT, { recursive: true, force: true }); // Delete the leftover profile dir and its contents
      console.log(
        `[SWEEP] Removed leftover Chrome profile dir from a previous run: ${CHROME_PROFILE_ROOT}`,
      ); // Log that a leftover dir was found and removed
    } // Close the current block scope.
  } catch (error) {
    // Execute this statement as part of the export workflow.
    console.warn(
      `[SWEEP] Could not remove leftover Chrome profile dir ${CHROME_PROFILE_ROOT}: ${error.message}`,
    ); // Log a warning; this is non-fatal, so the script continues normally
  } // Close the current block scope.
} // Close the current block scope.

/**
 * Sweeps /tmp/Downloads, which is where the browser's default download directory ends
 * up if a client page's download path was never (or only partially) configured before
 * a crash — or, mid-run, if a download briefly landed there before
 * configureBrowserDownloadPath() finished applying. Only files matching the export
 * naming convention (e.g. "abingdonil-il-1.txt") are removed, so unrelated files are
 * left alone.
 *
 * Unlike sweepOrphanedChromiumTempFiles(), this is safe (and intended) to call
 * repeatedly during a run — once at the start of every loop pass, and again after each
 * region/state finishes processing — since a fresh batch of matching files can appear
 * at any point.
 * @returns {void}
 */
function sweepOrphanedDownloadFiles() {
  const systemTempDirectoryPath = os.tmpdir(); // Get the OS temp directory path (this is /tmp on Linux/EC2)
  const orphanedDownloadsDirectoryPath = path.join(
    systemTempDirectoryPath,
    "Downloads",
  ); // Build the path to /tmp/Downloads
  // BUG FIX: the original pattern was /^[a-z0-9_]+-[a-z]{2}-\d+\.txt$/i, which excludes
  // hyphens from the client-slug portion. Real client slugs (e.g. "lake-charles-la-1.txt")
  // contain hyphens, so those leftover files were silently never swept. Allow hyphens
  // in that leading segment as well.
  const orphanedExportFilePattern = /^[a-z0-9-]+-[a-z]{2}-\d+\.txt$/i; // Matches the export naming convention, e.g. lake-charles-la-1.txt
  let deletedDownloadFileCount = 0; // Counter for how many leftover downloaded files we remove

  try {
    // Begin the Downloads cleanup attempt, in case the folder can't be read
    if (fs.existsSync(orphanedDownloadsDirectoryPath)) {
      // Only attempt cleanup if the folder actually exists
      const downloadEntries = fs.readdirSync(orphanedDownloadsDirectoryPath); // List everything currently sitting in /tmp/Downloads

      for (const entryName of downloadEntries) {
        // Loop through each file/folder name found in the Downloads directory
        const nameMatchesExportPattern =
          orphanedExportFilePattern.test(entryName); // Check if this entry's name matches the known export filename shape

        if (!nameMatchesExportPattern) {
          // Skip anything that doesn't look like one of our export files
          continue; // Move on to the next entry without touching this one
        } // End of the pattern-match check

        const fullEntryPath = path.join(
          orphanedDownloadsDirectoryPath,
          entryName,
        ); // Build the full path to this entry

        try {
          // Attempt to delete this single entry (kept separate so one bad entry doesn't stop the whole sweep)
          const entryStat = fs.statSync(fullEntryPath); // Check if it's a file or directory
          if (entryStat.isFile()) {
            // Only remove files (skip any subdirectories, just to be safe)
            fs.rmSync(fullEntryPath, { force: true }); // Delete the leftover downloaded file
            deletedDownloadFileCount++; // Increment our counter since the deletion succeeded
          } // End of the isFile check
        } catch (deletionError) {
          // Handle the case where this specific entry couldn't be deleted (e.g. permissions, in-use file)
          console.warn(
            `[SWEEP] Could not remove ${fullEntryPath}: ${deletionError.message}`,
          ); // Log a warning but keep going with the rest of the sweep
        } // End of the per-entry delete attempt
      } // End of the loop over all Downloads directory entries

      console.log(
        // Log a final summary once the Downloads sweep finishes
        `[SWEEP] Cleared ${deletedDownloadFileCount} leftover export file(s) matching pattern from ${orphanedDownloadsDirectoryPath}.`, // Human-readable summary of how many export files were cleaned up and where
      ); // End of the summary log statement
    } else {
      // Execute this statement if the Downloads directory doesn't exist
      console.log(
        `[SWEEP] No orphaned downloads directory found at ${orphanedDownloadsDirectoryPath}.`,
      ); // Nothing to clean up
    } // End of the existence check
  } catch (scanError) {
    // Handle the case where the Downloads directory itself couldn't even be read
    console.warn(
      `[SWEEP] Could not scan ${orphanedDownloadsDirectoryPath}: ${scanError.message}`,
    ); // Log a warning; this is non-fatal, so the script continues normally
  } // End of the outer try/catch for the Downloads sweep
} // Close the current block scope.

// API COMMUNICATION FUNCTIONS

/**
 * Performs a non-navigating GET request within the browser's context.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} requestUrl - The API endpoint URL.
 * @param {string} fingerprintValue - The authentication fingerprint cookie value.
 * @returns {Promise<Object|null>} The parsed JSON data or null on failure.
 */
async function executeApiGetRequest(page, requestUrl, fingerprintValue) {
  // Define an async function for this workflow step.
  try {
    // Start protected execution that may throw errors.
    console.log(`[API_GET] 🌐 Sending GET request to: ${requestUrl}`); // Log the request URL

    const response = await page.evaluate(
      // Run this function inside the page's browser context (not Node)
      async (apiUrl, fingerprint, timeout) => {
        // Execute this statement as part of the export workflow.
        // Execute code inside the browser context
        const controller = new AbortController(); // Create an abort controller for timeouts
        const timeoutId = setTimeout(() => controller.abort(), timeout); // Set up the timeout mechanism

        try {
          // Start protected execution that may throw errors.
          const res = await fetch(apiUrl, {
            // Declare a constant used in the current scope.
            method: "GET", // Use the GET HTTP method
            headers: {
              // Execute this statement as part of the export workflow.
              "Content-Type": "application/json", // Tell the server we expect JSON
              Fingerprint: fingerprint, // Add the authentication header
            }, // Execute this statement as part of the export workflow.
            signal: controller.signal, // Link the abort controller
          }); // Close the current block and complete the related call.
          clearTimeout(timeoutId); // Clear the timeout if the request succeeds

          if (!res.ok) {
            // Check this condition before continuing.
            // Handle HTTP error statuses
            return {
              // Return the computed result for this execution path.
              status: res.status, // The raw HTTP status code
              data: `HTTP error! status: ${res.status}`, // A human-readable error message
            }; // Execute this statement as part of the export workflow.
          } // Close the current block scope.
          return {
            // Return the computed result for this execution path.
            status: res.status, // The successful HTTP status code
            data: await res.text(), // Return the response body as text
          }; // Execute this statement as part of the export workflow.
        } catch (error) {
          // Execute this statement as part of the export workflow.
          clearTimeout(timeoutId); // Clear the timeout if an error occurs
          return {
            // Return the computed result for this execution path.
            status: 0, // Sentinel status meaning "request never completed"
            data: `Request failed or timed out: ${error.message}`, // Build a dynamic log or error string using runtime values.
          }; // Return a generic failure object
        } // Close the current block scope.
      }, // Execute this statement as part of the export workflow.
      requestUrl, // The URL argument passed into the browser context function
      fingerprintValue, // The fingerprint cookie argument
      BROWSER_NAVIGATION_TIMEOUT_MS, // The timeout argument
    ); // Pass arguments to the browser function

    if (response.status >= 200 && response.status < 300) {
      // Check this condition before continuing.
      // Check for success status codes
      console.log(
        // Write an informational progress message to the console.
        `[API_GET] ✅ Success (${response.status}) from ${requestUrl}`, // Build a dynamic log or error string using runtime values.
      ); // Log success
      try {
        // Attempt to parse the response body as JSON
        return JSON.parse(response.data); // Parse the JSON response
      } catch (parseErr) {
        // Catch a malformed/non-JSON response body
        console.error(
          `[API_GET] ❌ Failed to parse JSON from ${requestUrl}: ${parseErr.message}`,
        ); // Log the parse error explicitly instead of letting it bubble uncaught
        return null; // Treat a bad parse the same as a failed request
      } // Close the current block scope.
    } else {
      // Execute this statement as part of the export workflow.
      console.error(
        // Write an error message to the console for diagnostics.
        `[API_GET] ❌ Request failed. Status: ${response.status}. Response: ${response.data}`, // Build a dynamic log or error string using runtime values.
      ); // Log API failure
      return null; // Return the computed result for this execution path.
    } // Close the current block scope.
  } catch (err) {
    // Execute this statement as part of the export workflow.
    console.error(
      // Write an error message to the console for diagnostics.
      `[API_GET] ❌ Error executing GET request to ${requestUrl}: ${err.message}`, // Build a dynamic log or error string using runtime values.
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
  page, // The Puppeteer page to run the fetch from
  versionUuid, // The code version UUID to export
  scopeArray, // Flattened TOC scope array (uuid + slug pairs)
  fingerprintValue, // Auth cookie value
) {
  // Close the current parenthesized expression.
  try {
    // Start protected execution that may throw errors.
    const exportApiUrl = `${API_BASE_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}`; // Export API endpoint URL
    const requestPayload = {
      // Declare a constant used in the current scope.
      version: versionUuid, // Version UUID being requested
      scope: JSON.stringify(scopeArray), // Scope must be a stringified JSON array
      output_format: "txt", // Request text output format
      for_print: false, // Not for print
    }; // Execute this statement as part of the export workflow.

    console.log(
      // Write an informational progress message to the console.
      `[EXPORT] 📤 Sending Payload: Version=${versionUuid} | Scope Parts=${scopeArray.length}`, // Build a dynamic log or error string using runtime values.
    ); // Close the current parenthesized expression.
    console.log(`[EXPORT] 🌐 Sending POST request to: ${exportApiUrl}`); // Log POST request

    const response = await page.evaluate(
      // Run this function inside the page's browser context (not Node)
      async (url, payload, fingerprint, timeout) => {
        // Execute this statement as part of the export workflow.
        // Execute code inside the browser context
        const controller = new AbortController(); // Abort controller for timeout
        const timeoutId = setTimeout(() => controller.abort(), timeout); // Set timeout

        try {
          // Start protected execution that may throw errors.
          const res = await fetch(url, {
            // Declare a constant used in the current scope.
            method: "POST", // Use the POST HTTP method
            headers: {
              // Execute this statement as part of the export workflow.
              "Content-Type": "application/json", // Tell the server we're sending JSON
              Fingerprint: fingerprint, // Add fingerprint header
            }, // Execute this statement as part of the export workflow.
            body: JSON.stringify(payload), // Send the payload as a JSON string
            signal: controller.signal, // Link abort controller
          }); // Close the current block and complete the related call.
          clearTimeout(timeoutId); // Clear timeout on success
          return {
            // Return the computed result for this execution path.
            status: res.status, // The HTTP status code returned
            data: await res.text(), // Return status and text
          }; // Execute this statement as part of the export workflow.
        } catch (error) {
          // Execute this statement as part of the export workflow.
          clearTimeout(timeoutId); // Clear timeout on failure
          return {
            // Return the computed result for this execution path.
            status: 0, // Sentinel status meaning the request never completed
            data: `Request failed or timed out: ${error.message}`, // Build a dynamic log or error string using runtime values.
          }; // Return generic failure
        } // Close the current block scope.
      }, // Execute this statement as part of the export workflow.
      exportApiUrl, // The URL argument passed into the browser context function
      requestPayload, // The JSON payload argument
      fingerprintValue, // The fingerprint cookie argument
      BROWSER_NAVIGATION_TIMEOUT_MS, // The timeout argument
    ); // Pass arguments

    if (response.status === 201) {
      // Check this condition before continuing.
      // Check for 201 Created status
      try {
        // Attempt to parse the export job response body as JSON
        return JSON.parse(response.data); // Return the parsed job response (includes UUID)
      } catch (parseErr) {
        // Catch a malformed/non-JSON response body
        console.error(
          `[EXPORT] ❌ Failed to parse export job response: ${parseErr.message}`,
        ); // Log the parse error explicitly
        return null; // Treat a bad parse the same as a failed submission
      } // Close the current block scope.
    } else {
      // Execute this statement as part of the export workflow.
      console.error(
        // Write an error message to the console for diagnostics.
        `[EXPORT] ❌ Request failed. Status: ${response.status}. Response: ${response.data}`, // Build a dynamic log or error string using runtime values.
      ); // Log POST failure
      return null; // Return the computed result for this execution path.
    } // Close the current block scope.
  } catch (err) {
    // Execute this statement as part of the export workflow.
    console.error(
      // Write an error message to the console for diagnostics.
      `[EXPORT] ❌ Error submitting export request: ${err.message}`, // Build a dynamic log or error string using runtime values.
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
async function retrieveAllExportJobStatuses(page, fingerprintValue) {
  // Define an async function for this workflow step.
  try {
    // Start protected execution that may throw errors.
    const statusUrl = `${API_BASE_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}`; // Status check API URL
    const response = await page.evaluate(
      // Run this function inside the page's browser context (not Node)
      async (url, fingerprint, timeout) => {
        // Execute this statement as part of the export workflow.
        // Execute code inside the browser context
        const controller = new AbortController(); // Abort controller
        const timeoutId = setTimeout(() => controller.abort(), timeout); // Set timeout

        try {
          // Start protected execution that may throw errors.
          const res = await fetch(url, {
            // Declare a constant used in the current scope.
            method: "GET", // Use the GET HTTP method
            headers: {
              // Execute this statement as part of the export workflow.
              Fingerprint: fingerprint, // Include fingerprint header
            }, // Execute this statement as part of the export workflow.
            signal: controller.signal, // Link abort controller
          }); // Close the current block and complete the related call.
          clearTimeout(timeoutId); // Clear timeout
          // BUG FIX: this used to return res.text() directly with no status info, even
          // on HTTP error responses (401/500/HTML error pages). The caller then tried to
          // JSON.parse an error page and failed with a confusing parse error instead of
          // a clear status error. Now returns status + text together, mirroring the GET
          // helper's shape, so the caller can branch on status before parsing.
          return { status: res.status, data: await res.text() }; // Return both the HTTP status and the raw body text
        } catch (error) {
          // Execute this statement as part of the export workflow.
          clearTimeout(timeoutId); // Clear timeout on failure
          return {
            status: 0,
            data: `Request failed or timed out: ${error.message}`,
          }; // Return a generic failure object instead of throwing
        } // Close the current block scope.
      }, // Execute this statement as part of the export workflow.
      statusUrl, // The URL argument passed into the browser context function
      fingerprintValue, // The fingerprint cookie argument
      BROWSER_NAVIGATION_TIMEOUT_MS, // The timeout argument
    ); // Pass arguments

    if (response.status < 200 || response.status >= 300) {
      // Check whether the HTTP status indicates a failure
      console.error(
        `[STATUS] ❌ Request failed. Status: ${response.status}. Response: ${response.data}`,
      ); // Log the failed status check with its status code and body
      await pauseExecutionSimple(EXPORT_POLL_INTERVAL_MS); // Back off for one normal poll interval before the caller retries
      return null; // Signal failure to the caller without attempting to parse JSON
    } // Close the current block scope.

    return JSON.parse(response.data); // Parse the list of jobs from the successful response body
  } catch (err) {
    // Catch any error from the evaluate call above, or from JSON.parse
    console.error(`[STATUS] ❌ Error checking export status: ${err.message}`); // Log error
    await pauseExecutionSimple(EXPORT_POLL_INTERVAL_MS); // Back off for one normal poll interval before the caller retries
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
  page, // The Puppeteer page to run polling fetches from
  exportJobUuid, // The job UUID being watched
  fingerprintValue, // Auth cookie value
) {
  // Close the current parenthesized expression.
  const maxAttempts = // Declare a constant used in the current scope.
    Math.ceil((MAX_EXPORT_WAIT_MINUTES * 60000) / EXPORT_POLL_INTERVAL_MS); // Calculate max attempts based on time and interval
  const shortJobId = exportJobUuid; // full ID, no substring
  console.log(
    // Write an informational progress message to the console.
    `[STATUS: ${shortJobId}] ⏳ Starting poll (max ${MAX_EXPORT_WAIT_MINUTES} min / ${maxAttempts} attempts)`, // Build a dynamic log or error string using runtime values.
  ); // Log polling parameters

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Iterate through values in this collection or range.
    // Loop for max attempts
    await pauseExecutionWithLog(EXPORT_POLL_INTERVAL_MS); // Wait for the poll interval

    const exportsList = await retrieveAllExportJobStatuses(
      // Declare a constant used in the current scope.
      page, // Page to run the fetch from
      fingerprintValue, // Auth cookie
    ); // Get the list of all job statuses
    if (!Array.isArray(exportsList)) continue; // Skip if list is not valid

    const targetExport = exportsList.find((job) => job.uuid === exportJobUuid); // Find the specific job by UUID
    if (!targetExport) {
      // Check this condition before continuing.
      console.log(
        // Write an informational progress message to the console.
        `[STATUS: ${shortJobId}] Attempt ${attempt}/${maxAttempts}. Job status not yet available. Retrying`, // Build a dynamic log or error string using runtime values.
      ); // Log if the job hasn't appeared yet
      continue; // Skip to the next loop iteration.
    } // Close the current block scope.

    const taskState = targetExport.task?.post_state; // Get the state of the task
    const progress = targetExport.task?.progress || 0; // Get the progress percentage

    if (taskState === "SUCCESS") {
      // Check this condition before continuing.
      // Check for success
      console.log(`[STATUS: ${shortJobId}] ✅ Completed successfully.`); // Log success
      return true; // Return the computed result for this execution path.
    } // Close the current block scope.

    if (taskState === "FAILURE") {
      // Check this condition before continuing.
      // Check for failure
      console.error(`[STATUS: ${shortJobId}] ❌ Failed. State: FAILURE.`); // Log failure
      return false; // Return the computed result for this execution path.
    } // Close the current block scope.

    console.log(
      // Write an informational progress message to the console.
      // Compose a multi-line template literal for poll attempt, progress, and task state.
      `[STATUS: ${shortJobId}] Attempt ${attempt}/${maxAttempts}. Progress: ${progress}% (${
        taskState || "PENDING"
      })`, // Finish the polling progress template string with final state text.
    ); // Log current status and progress
  } // Close the current block scope.

  console.warn(
    // Write a warning message to highlight a non-fatal issue.
    `[STATUS: ${shortJobId}] ⚠️ Did not complete within ${MAX_EXPORT_WAIT_MINUTES} minutes. Timeout reached.`, // Build a dynamic log or error string using runtime values.
  ); // Log timeout
  return false; // Return the computed result for this execution path.
} // Close the current block scope.

// Specific API Wrappers

// Fetches a list of all region slugs.
async function fetchAllRegionSlugs(page, apiUrl, fingerprintCookie) {
  // Define an async function for this workflow step.
  console.log(`[REGION] 🌐 Fetching all region slugs from API: ${apiUrl}`); // Log the action
  const regionsData = await executeApiGetRequest(
    // Declare a constant used in the current scope.
    page, // Page to run the fetch from
    apiUrl, // URL to fetch
    fingerprintCookie, // Auth cookie
  ); // Execute the GET request
  return (
    // Return the computed result for this execution path.
    regionsData?.filter((region) => region.slug).map((region) => region.slug) || // Filter out entries with no slug, then map to just the slug string
    [] // Fall back to an empty array if regionsData was null/undefined
  ); // Filter for valid slugs and return them as an array
} // Close the current block scope.

// Fetches details for a specific region (client list).
async function retrieveRegionDetails( // Define an async function for this workflow step.
  page, // Page to run the fetch from
  apiUrl, // URL to fetch
  regionSlug, // Used only for the log line below
  fingerprintCookie, // Auth cookie
) {
  // Close the current parenthesized expression.
  console.log(`[REGION] 🌐 Fetching region details for ${regionSlug}`); // Log the action
  return executeApiGetRequest(page, apiUrl, fingerprintCookie); // Execute the GET request
} // Close the current block scope.

// Fetches details for a specific client (code version list).
async function retrieveClientDetails( // Define an async function for this workflow step.
  page, // Page to run the fetch from
  apiUrl, // URL to fetch
  clientSlug, // Used only for the log line below
  fingerprintCookie, // Auth cookie
) {
  // Close the current parenthesized expression.
  console.log(`[CLIENT] 🌐 Fetching client details for ${clientSlug}`); // Log the action
  return executeApiGetRequest(page, apiUrl, fingerprintCookie); // Execute the GET request
} // Close the current block scope.

// Fetches the specific code version details and its Table of Contents (TOC).
async function retrieveVersionAndTableOfContents( // Define an async function for this workflow step.
  page, // Page to run the fetch from
  apiUrl, // URL to fetch
  versionId, // Used only for the log line below
  fingerprintCookie, // Auth cookie
) {
  // Close the current parenthesized expression.
  console.log(
    // Write an informational progress message to the console.
    `[VERSION] 🌐 Fetching details for version ${versionId}`, // Build a dynamic log or error string using runtime values.
  ); // Close the current parenthesized expression.
  return executeApiGetRequest(page, apiUrl, fingerprintCookie); // Execute the GET request
} // Close the current block scope.

// DOWNLOAD AND FILE MANAGEMENT

/**
 * Downloads the export file into a per-client temp folder and moves it to its
 * final destination once the download fully completes.
 * @param {puppeteer.Page} page - Puppeteer page instance controlling the browser.
 * @param {string} exportJobUuid - Export job UUID used to construct the download URL.
 * @param {string} watchFolderPath - The temp folder the browser is currently downloading into.
 * @param {string} saveFilePath - Final destination path for the completed file.
 * @returns {Promise<boolean>} Returns true if download succeeded, otherwise false.
 */
async function downloadExportFileAndRename( // Define async function to control the download workflow.
  page, // Puppeteer page used to trigger and detect the download
  exportJobUuid, // Job UUID used to construct the download URL
  watchFolderPath, // Temp folder currently configured as this page's download target
  saveFilePath, // Final destination path for the completed file
) {
  const finalExportFileName = path.basename(saveFilePath); // Extract the final filename from the target save path.
  try {
    // Begin protected execution block to catch errors.
    const filesBeforeDownload = new Set( // Create a Set of filenames for quick lookup comparison.
      getDirectoryFilesExcludingTemp(watchFolderPath), // Get all existing files in the temp folder excluding temp extensions.
    ); // Store the list before the new download begins.
    const downloadUrl = `${DOWNLOAD_API_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}${exportJobUuid}/download/`; // Build the final download URL using configuration constants.
    console.log(`[DOWNLOAD] 🌐 Visiting ${downloadUrl}`); // Log the URL that triggers the export download.

    // BUG FIX: navigating to a URL that triggers a file download (Content-Disposition:
    // attachment) makes Puppeteer's page.goto() reject with "net::ERR_ABORTED" — this
    // is expected browser behavior, NOT a real failure; the download still proceeds via
    // CDP. Previously this rejection was caught by the outer catch and reported the
    // whole download as failed even when the file downloaded successfully. We now
    // swallow that specific expected error and only rethrow genuinely unexpected ones.
    try {
      // Attempt the navigation that triggers the file download
      await page.goto(downloadUrl, {
        // Instruct Puppeteer to navigate to the download endpoint.
        waitUntil: "networkidle2", // Wait until network activity stabilizes before continuing.
        timeout: BROWSER_NAVIGATION_TIMEOUT_MS, // Allow up to 5 minutes for large export downloads.
      }); // End navigation command.
    } catch (navError) {
      // Catch the navigation rejection so we can inspect what kind of error it is
      const isExpectedDownloadAbort = /ERR_ABORTED/i.test(
        navError.message || "",
      ); // Check if this is the expected "download started" abort
      if (!isExpectedDownloadAbort) {
        // If this is some other, unexpected navigation error
        throw navError; // Rethrow so the outer catch reports a genuine failure
      } // Close the current block scope.
      console.log(
        `[DOWNLOAD] Navigation aborted as expected (download started).`,
      ); // Log that this abort was expected, not a real error
    } // Close the current block scope.

    console.log(`[DOWNLOAD] Waiting for download to finish...`); // Inform logs that we are waiting for filesystem download completion.

    // Poll until a genuinely NEW file (not present before) shows up and has finished
    // downloading (no longer has a temp extension). This avoids falsely reporting
    // success if polling starts before Chrome even creates its .crdownload file.
    const downloadedFile = await waitForNewCompletedFile(
      // Wait for a brand-new, fully-downloaded file to appear
      watchFolderPath, // Folder to watch
      filesBeforeDownload, // Snapshot of files that existed before this download started
      BROWSER_NAVIGATION_TIMEOUT_MS, // How long to wait before giving up
    ); // Resolves with the new filename, or null on timeout

    if (!downloadedFile) {
      // If no new completed file was detected within the timeout
      throw new Error("Unable to identify completed download file."); // Throw error because no file was detected.
    } // End detection logic.

    const tempFilePath = path.join(watchFolderPath, downloadedFile); // Construct the full path of the completed downloaded file.
    // Move the completed file to its final location and overwrite if necessary
    fs.renameSync(tempFilePath, saveFilePath); // Rename and move the downloaded file to the final save path (replaces existing file).
    console.log(`[DOWNLOAD] ✅ File saved as: ${finalExportFileName}`); // Log successful file replacement.
    return true; // Return success status.
  } catch (err) {
    // Catch any errors that occurred during the workflow.
    console.error(
      // Print error message to logs for debugging.
      `[DOWNLOAD] ❌ Error downloading job ${exportJobUuid}: ${err.message}`, // Include job ID and detailed error message.
    ); // End error logging.
    return false; // Return failure status to the calling code.
  } // End try/catch block.
} // End function definition.

/**
 * Helper function to safely read directory contents, filtering out temp files.
 * @param {string} directoryPath - The path to the directory.
 * @returns {Array<string>} List of file names.
 */
function getDirectoryFilesExcludingTemp(directoryPath) {
  // Define a helper function used by the export process.
  const tempExtensions = [".tmp", ".crdownload", ".part", ".download"]; // List of temporary file extensions
  try {
    // Start protected execution that may throw errors.
    return fs // Return the computed result for this execution path.
      .readdirSync(directoryPath) // Read all files in the directory
      .filter(
        // Execute this statement as part of the export workflow.
        (
          file, // The current filename being checked
        ) => !tempExtensions.some((ext) => file.toLowerCase().endsWith(ext)), // Keep only files that do NOT end with a temp extension
      ); // Filter out files ending with temp extensions
  } catch (e) {
    // Execute this statement as part of the export workflow.
    console.error(
      // Write an error message to the console for diagnostics.
      `[UTIL] Error reading directory ${directoryPath}: ${e.message}`, // Build a dynamic log or error string using runtime values.
    ); // Log directory read error
    return []; // Return the computed result for this execution path.
  } // Close the current block scope.
} // Close the current block scope.

/**
 * Polls directoryPath until a file appears that was not present in filesBeforeSet and
 * is no longer a temp/in-progress file (i.e. the browser finished writing it).
 * @param {string} directoryPath - The folder to watch for a new completed file.
 * @param {Set<string>} filesBeforeSet - Filenames that existed before the download started.
 * @param {number} timeoutMs - The maximum time to wait in milliseconds.
 * @returns {Promise<string|null>} The new filename, or null on timeout.
 */
async function waitForNewCompletedFile(
  directoryPath,
  filesBeforeSet,
  timeoutMs = 300000,
) {
  const pollIntervalMs = 1000; // Check once per second
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs); // Total number of polling attempts before giving up

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Loop up to maxAttempts times
    await pauseExecutionSimple(pollIntervalMs); // Wait one poll interval before checking again

    let currentFiles; // Will hold the current non-temp file listing
    try {
      // Attempt to read the directory's current contents
      currentFiles = getDirectoryFilesExcludingTemp(directoryPath); // Get the current list of fully-downloaded (non-temp) files
    } catch (e) {
      // Catch any unexpected error from the directory read itself
      continue; // Just try again on the next poll interval
    } // Close the current block scope.

    const newFile = currentFiles.find((file) => !filesBeforeSet.has(file)); // Look for a file that wasn't there before the download started
    if (newFile) return newFile; // Found it — return the new filename immediately
  } // Close the for loop

  return null; // Timed out without finding a new completed file
} // Close the current block scope.

// EXPORT SCOPE UTILITY

/**
 * Recursively traverses a nested Table of Contents (TOC) structure
 * and collects all UUIDs and slugs for the full export scope.
 * @param {Array<Object>} tocArray - The array of TOC items.
 * @param {Array<Object>} scope - The current collection of UUID/slug objects.
 * @returns {Array<Object>} The complete list of objects for the export scope.
 */
function collectAllTOCItemsForExport(tocArray, scope = []) {
  // Define a helper function used by the export process.
  if (!Array.isArray(tocArray)) return scope; // Base case: return if not an array

  for (const item of tocArray) {
    // Iterate through values in this collection or range.
    // Iterate through items
    // Step 1: Add the current item's UUID and slug
    if (item.uuid && item.slug) {
      // Check this condition before continuing.
      // Check for required properties
      scope.push({
        // Execute this statement as part of the export workflow.
        uuid: item.uuid, // The TOC item's unique identifier
        code_slug: item.slug, // The TOC item's slug value
      }); // Add the current item to the scope
    } // Close the current block scope.
    // Step 2: Recursively check for nested children
    if (item.children && Array.isArray(item.children)) {
      // Check this condition before continuing.
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
async function initializeClientPageSession(page) {
  // Define an async function for this workflow step.
  await page.goto(API_BASE_DOMAIN, {
    // Wait for this asynchronous operation to finish.
    waitUntil: "domcontentloaded", // Only wait for the DOM to be ready, not full network idle
    timeout: BROWSER_NAVIGATION_TIMEOUT_MS, // Apply the standard timeout
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
function resolveClientStateSlug(clientData, regionSlug, clientSlug) {
  // Define a helper function used by the export process.
  const slugMatch = // Declare a constant used in the current scope.
    typeof clientSlug === "string" // Only attempt regex match if clientSlug is actually a string
      ? clientSlug.match(/-([a-z]{2})$/i) // Try to pull a trailing 2-letter state code off the slug
      : null; // Otherwise there's nothing to match against
  const slugDerivedState = slugMatch ? slugMatch[1] : null; // Extract the captured group if the match succeeded

  const possibleValues = [
    // Ordered list of candidate values to try, most specific first
    clientData?.state_slug, // Explicit state_slug field, if present
    clientData?.state, // Explicit state field, if present
    clientData?.state_abbr, // Explicit state_abbr field, if present
    clientData?.region_slug, // Explicit region_slug field, if present
    clientData?.region?.slug, // Nested region object's slug, if present
    slugDerivedState, // State code derived from the client slug via regex
    regionSlug, // Final fallback: the region slug passed in from the caller
  ]; // Close the current array or bracketed expression.

  for (const value of possibleValues) {
    // Check each candidate value in priority order
    if (typeof value === "string" && value.trim()) {
      // Check this condition before continuing.
      return value.trim().toLowerCase(); // Return the first non-empty string value, normalized to lowercase
    } // Close the current block scope.
  } // Close the current block scope.

  return "unknown-state"; // Return the computed result for this execution path.
} // Close the current block scope.

/**
 * Generates a random integer between 0 (inclusive) and 99 (inclusive).
 * This function is inclusive of 0 and inclusive of 99.
 * @returns {number} A random integer from 0 to 99.
 */
function generateRandomNumber() {
  // Define a helper function used by the export process.
  // Math.random() generates a float from [0, 1)
  // Multiplying by 100 gives a range of [0, 100)
  // Math.floor() rounds down, resulting in an integer from [0, 99].
  return Math.floor(Math.random() * 100); // Return the computed result for this execution path.
} // Close the current block scope.

// EXECUTION

/**
 * Entry point — runs the export process forever, with a delay between passes.
 * A failed pass is logged and retried after the same delay rather than exiting.
 * @returns {Promise<void>}
 */
async function main() {
  // Define the main entry point as an async function
  sweepOrphanedChromiumTempFiles(); // Run ONCE, before anything else: no Chrome instance is running yet this process, so it's safe to clear crashed-run debris matching known patterns
  removeLeftoverChromeProfileDir(); // Run ONCE, before anything else: clean up a pinned profile dir left behind if the previous run crashed before it could close Chrome
  while (true) {
    // Loop forever, running one pass per iteration
    sweepOrphanedDownloadFiles(); // Run at the start of every loop pass, so /tmp/Downloads starts clean for each pass
    try {
      // Start protected execution that may throw errors
      await executeCodeExportProcess(); // Wait for a single full export pass to finish
      console.log("\n--- Pass complete. ---"); // Log that this pass finished successfully
    } catch (err) {
      // Catch any error thrown during this pass
      console.error("Fatal error outside main execution block:", err); // Log the error details for debugging
    } // Close the current block scope

    console.log(
      `[LOOP] Waiting ${DELAY_BETWEEN_LOOPS_MS / 60000} minutes before next pass...`,
    ); // Log how long we'll wait before looping again
    await pauseExecutionSimple(DELAY_BETWEEN_LOOPS_MS); // Pause execution for the configured delay before starting the next pass
  } // Close the while loop
} // Close the main function

main(); // Call main to start the forever-looping export process

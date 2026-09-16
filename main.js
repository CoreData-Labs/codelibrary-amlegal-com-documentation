// =============================================================================
// SECTION: IMPORTS
// =============================================================================
import fs from "fs"; // Core Node.js module for file system operations (create/read/delete files & folders)
import path from "path"; // Core Node.js module for building and resolving file paths safely across OSes
import os from "os"; // Core Node.js module for OS-level paths (used to find the system /tmp directory)
import puppeteer from "puppeteer"; // Browser automation library — drives a real Chrome instance for us

// =============================================================================
// SECTION: CONFIGURATION CONSTANTS
// Everything in this section is a fixed setting the rest of the script reads from.
// Nothing in here changes while the script runs.
// =============================================================================

// --- Browser Configuration ---
const IS_BROWSER_HEADLESS = false; // false = visible Chrome window (useful for debugging); true = no window (for servers)
const BROWSER_NAVIGATION_TIMEOUT_MS = 300000; // 5 minutes — max time we'll wait for any single page navigation or API call

// --- File System Configuration ---
const ASSET_OUTPUT_BASE_DIRECTORY = "assets"; // Root folder where every downloaded code file ends up
const EXPORT_FILE_EXTENSION = ".txt"; // File extension used for the final downloaded code exports
const VERSION_FILE_SUFFIX = "-1"; // Suffix appended to the filename (e.g. "sandpoint-ak-1.txt")
const CHECK_IF_FILE_EXISTS = false; // When true, skip a client entirely if its final file already exists on disk

// --- Chrome Profile Configuration ---
// Pinning Chrome's userDataDir here (instead of letting Puppeteer use a random OS temp
// folder) keeps everything Chrome-related inside a folder WE control, so we can find and
// delete it reliably at the start/end of every run.
const CHROME_PROFILE_ROOT = path.join(
  ASSET_OUTPUT_BASE_DIRECTORY, // Nest the profile under our own assets folder
  ".chrome-profile", // Hidden folder name so it doesn't look like a normal output folder
);

// --- API Domains and Endpoints ---
const API_BASE_DOMAIN = "https://codelibrary.amlegal.com"; // Where region/client/version JSON data lives
const DOWNLOAD_API_DOMAIN = "https://export.amlegal.com"; // Where the actual finished export files are downloaded from

const REGIONS_API_ENDPOINT = "/api/client-regions/"; // Returns the full list of regions (e.g. states)
const EXPORT_REQUESTS_API_ENDPOINT = "/api/export-requests/"; // Used to both START an export job and CHECK on all jobs' status
const CLIENT_API_ENDPOINT_PREFIX = "/api/clients/"; // Prefix + client slug = a single client's details
const CODE_VERSION_API_ENDPOINT_PREFIX = "/api/code-versions/"; // Prefix + version UUID = that version's Table of Contents

// --- Authentication ---
const AUTH_FINGERPRINT_COOKIE_NAME = "_alp_fp"; // Name of the cookie the site requires on every authenticated API call

// --- Timing / Polling Configuration ---
const MAX_EXPORT_WAIT_MINUTES = 15; // Give up waiting on a single export job after this many minutes
const EXPORT_POLL_INTERVAL_MS = 15000; // How often (15 seconds) we check an export job's status
const DELAY_BETWEEN_LOOPS_MS = 30 * 60000; // How long to wait (30 minutes) between full passes over every region

// --- Processing Order ---
// const REGION_START_PERCENT = generateRandomNumber(); // (Optional) start partway through the region list at a random point
const REGION_START_PERCENT = 0; // Percentage (0-99) of the way through the region list to start processing from

// =============================================================================
// SECTION: SHARED PASS-LEVEL CACHE STATE
// These variables exist so that ONE pass of the script (one full run through every
// region) can avoid sending duplicate HTTP requests when multiple clients need the
// same information around the same time. They are reset at the start of every pass
// inside executeCodeExportProcess(), so nothing ever leaks from one pass to the next.
// =============================================================================

let sharedExportStatusCache = { list: null, fetchedAtMs: 0 }; // The most recently fetched full list of export-job statuses, plus when it was fetched
let sharedExportStatusFetchInFlight = null; // If a fetch is currently running, this holds that Promise so other callers can await the SAME one instead of starting a new one
let sharedExportStatusPage = null; // The one long-lived page used for status-list fetches (never a short-lived per-client page)

// =============================================================================
// SECTION: ENTRY POINT
// This is where the script actually starts running.
// =============================================================================

/**
 * The script's entry point. Runs forever: does one full pass over every region, waits
 * DELAY_BETWEEN_LOOPS_MS, then does it again. A failed pass is logged and retried after
 * the same delay — the script never exits on its own.
 * @returns {Promise<void>}
 */
async function main() {
  // One-time startup cleanup — safe to run here because no Chrome instance exists yet
  // and no client download can possibly be in progress.
  sweepOrphanedChromiumTempFiles(); // Remove leftover Chromium/Puppeteer debris from a crashed previous run
  removeLeftoverChromeProfileDir(); // Remove a leftover Chrome profile folder from a crashed previous run
  removeAllOrphanedClientTempFolders(); // Remove any leftover per-client ".tmp-*" folders from a crashed previous run

  while (true) {
    // Loop forever — one full export pass per iteration.
    // NOTE: sweeping /tmp/Downloads does NOT happen here. It needs the live region-slug
    // list, which is only fetched once per pass, inside executeCodeExportProcess() — see
    // that function for where the Downloads sweep actually happens.
    try {
      await executeCodeExportProcess(); // Run one complete pass: auth, discover regions, export every client
      console.log("\n--- Pass complete. ---"); // Confirm the pass finished without a fatal error
    } catch (passError) {
      // A fatal error escaped the whole pass (bad auth, browser crash, etc). Log it fully
      // and keep looping — one bad pass should never stop the script permanently.
      console.error(
        `Fatal error outside main execution block: ${passError.message}`,
        passError,
      ); // Log both the short message and the full error object
    }

    console.log(
      `[LOOP] Waiting ${DELAY_BETWEEN_LOOPS_MS / 60000} minutes before next pass...`,
    ); // Tell the operator how long until the next attempt
    await pauseExecutionSimple(DELAY_BETWEEN_LOOPS_MS); // Actually wait that long before looping again
  }
}

main(); // Kick everything off

// =============================================================================
// SECTION: PASS-LEVEL ORCHESTRATION
// One call to executeCodeExportProcess() = one complete pass over every region.
// =============================================================================

/**
 * Runs one complete export pass: launches a browser, authenticates, discovers every
 * region, and processes each region's clients in turn. Always cleans up the browser
 * (and Chrome profile, if it closed cleanly) in its finally block, no matter how the
 * pass ends.
 * @returns {Promise<void>}
 */
async function executeCodeExportProcess() {
  console.log("--- Script Start: Code Exporter Initialization ---"); // Announce the start of this pass

  ensureDirectoryExists(ASSET_OUTPUT_BASE_DIRECTORY); // Make sure the root output folder exists before anything else runs

  let browserInstance; // Will hold the Puppeteer Browser object for this pass
  let browserPage; // Will hold this pass's single long-lived Puppeteer Page object

  try {
    ({ browserInstance, browserPage } = await launchBrowserAndCreatePage()); // Start Chrome and open one page

    // Reset every shared cache at the start of THIS pass, so nothing from a previous
    // pass (which used a now-closed page) can accidentally be reused.
    sharedExportStatusCache = { list: null, fetchedAtMs: 0 }; // Clear any cached job-status list from a previous pass
    sharedExportStatusFetchInFlight = null; // Clear any leftover in-flight-fetch marker from a previous pass
    sharedExportStatusPage = browserPage; // Route this pass's cached status fetches through this pass's main page

    console.log("\n--- Phase 1: Authentication and Region Discovery ---"); // Announce phase 1

    const authenticationCookieValue =
      await retrieveAuthenticationCookie(browserPage); // Get the session cookie every later API call needs

    // CALL-REDUCTION: fetch the region slug list exactly ONCE for this whole pass. The
    // resulting array is reused below both for the Downloads sweep AND passed down into
    // every region's own end-of-region sweep, so the region API is never hit again for
    // that purpose during this pass.
    const regionsApiUrl = `${API_BASE_DOMAIN}${REGIONS_API_ENDPOINT}`; // Build the region-list API URL
    const regionIdentifiers = await fetchAllRegionSlugs(
      browserPage,
      regionsApiUrl,
      authenticationCookieValue,
    ); // The single source of truth for this pass's region list

    console.log(
      `[Phase 1 Complete] Found ${regionIdentifiers.length} regions to process.`,
    ); // Report how many regions were found

    // Clean up /tmp/Downloads now, reusing the region list we just fetched — no extra
    // HTTP request is made for this.
    sweepOrphanedDownloadFiles(regionIdentifiers); // Remove any leftover export files sitting in the OS Downloads folder

    // Decide which order to process regions in (normally start-to-finish, but can be
    // configured to start partway through via REGION_START_PERCENT).
    const regionsToProcess = buildRegionProcessingOrder(regionIdentifiers); // See helper below for the reordering logic

    console.log("\n--- Phase 2: Client and Version Identification ---"); // Announce phase 2

    for (const regionSlug of regionsToProcess) {
      // Process one region fully (all its clients) before moving on to the next.
      await processRegionForExports(
        browserPage,
        regionSlug,
        authenticationCookieValue,
        regionIdentifiers,
      ); // Do the actual export work for this region
    }

    console.log(
      "✓ Script Complete: All available region exports processed! 🎉",
    ); // Announce a fully successful pass
  } catch (errorDetails) {
    // A fatal error happened somewhere in setup or the main loop above. We log it and
    // RETHROW (rather than calling process.exit) so main()'s loop can catch this, log
    // it again at the top level, and retry after the configured delay instead of the
    // whole script dying.
    console.error("\n!!! FATAL SCRIPT ERROR (Browser/Setup) !!!"); // Fatal error banner
    console.error("Error details:", errorDetails.message); // The actual error message, for debugging
    throw errorDetails; // Hand the error up to main()
  } finally {
    // Cleanup that must always run, whether the pass succeeded or failed.
    const browserClosedCleanly = await closeBrowserSafely(browserInstance); // Attempt to close the browser; tells us whether it actually succeeded
    cleanUpChromeProfileIfSafe(browserClosedCleanly); // Only delete the Chrome profile folder if we KNOW Chrome shut down cleanly
    sharedExportStatusPage = null; // Drop the reference to this pass's (now closing) page so nothing can reuse it later
  }
}

/**
 * Decides which order to walk the region list in. Normally it's the plain original
 * order; if REGION_START_PERCENT is set above 0, the list is rotated so processing
 * starts partway through instead of always from the very beginning.
 * @param {Array<string>} regionIdentifiers - The full, unmodified region slug list.
 * @returns {Array<string>} The region slug list in the order to actually process it.
 */
function buildRegionProcessingOrder(regionIdentifiers) {
  if (REGION_START_PERCENT <= 0) {
    // No rotation requested — just process the list in its original order.
    console.log("[Order] Processing regions from the start."); // Tell the operator we're using the default order
    return regionIdentifiers; // Hand back the list unchanged
  }

  const startIndex = Math.floor(
    (regionIdentifiers.length * REGION_START_PERCENT) / 100,
  ); // Where REGION_START_PERCENT of the way through the list falls
  const clampedStartIndex = Math.min(startIndex, regionIdentifiers.length - 1); // Never let the start index run past the end of the array

  const rotatedRegionList = regionIdentifiers // Take the regions from the start index to the end...
    .slice(clampedStartIndex)
    .concat(regionIdentifiers.slice(0, clampedStartIndex)); // ...then wrap around and append everything before the start index

  console.log(
    `[Order] Starting from ${REGION_START_PERCENT}% of the list (index ${clampedStartIndex}).`,
  ); // Report exactly where we're starting from

  return rotatedRegionList; // Hand back the rotated order
}

// =============================================================================
// SECTION: REGION-LEVEL PROCESSING
// One call to processRegionForExports() = fully export every client in one region.
// =============================================================================

/**
 * Processes every client within a single region: fetches the client list, exports them
 * in small concurrent batches, then sweeps up any leftover temp files/folders once the
 * whole region is done.
 * @param {puppeteer.Page} page - This pass's main Puppeteer page (used for region-level API calls).
 * @param {string} regionSlug - The region currently being processed.
 * @param {string} authenticationCookieValue - The auth cookie needed for every API call.
 * @param {Array<string>} knownRegionSlugsForSweep - The full region slug list, already fetched once this pass, reused here so the end-of-region Downloads sweep makes no new HTTP request.
 * @returns {Promise<void>}
 */
async function processRegionForExports(
  page,
  regionSlug,
  authenticationCookieValue,
  knownRegionSlugsForSweep,
) {
  console.log(`\n=== START REGION: ${regionSlug} ===`); // Announce the start of this region

  const regionApiUrl = `${API_BASE_DOMAIN}${REGIONS_API_ENDPOINT}${regionSlug}/`; // Build this region's own detail-API URL
  const regionData = await retrieveRegionDetails(
    page,
    regionApiUrl,
    regionSlug,
    authenticationCookieValue,
  ); // Fetch this region's client list (one unavoidable call per region)
  if (!regionData) {
    // If we couldn't even get the region's data, there's nothing further we can do here.
    console.warn(
      `[${regionSlug}] ⚠️ Could not retrieve region details; skipping region entirely.`,
    ); // Explain exactly why we're bailing out
    return;
  }

  const clients = regionData.clients || []; // The list of clients belonging to this region (default to empty if the field is missing)
  console.log(`[${regionSlug}] Found ${clients.length} clients.`); // Report how many clients we found

  await processClientsInBatches(
    page,
    clients,
    regionSlug,
    authenticationCookieValue,
  ); // Do the actual client-by-client export work

  console.log(`\n=== END REGION: ${regionSlug} ===`); // Announce the end of this region

  // Once every client in this region has finished (successfully or not), sweep up any
  // leftover files/folders before moving on to the next region.
  sweepOrphanedDownloadFiles(knownRegionSlugsForSweep); // Clean /tmp/Downloads using the region slug list we already have — no new HTTP call
  removeAllOrphanedClientTempFolders(); // Clean up any ".tmp-*" client folders left behind by a crashed client download
}

/**
 * Splits a region's client list into small concurrent batches and exports each batch,
 * waiting for a batch to fully finish before starting the next one.
 * @param {puppeteer.Page} page - This pass's main Puppeteer page (used only to open new per-client pages from).
 * @param {Array<Object>} clients - The full list of clients to export for this region.
 * @param {string} regionSlug - The region these clients belong to.
 * @param {string} authenticationCookieValue - The auth cookie needed for every API call.
 * @returns {Promise<void>}
 */
async function processClientsInBatches(
  page,
  clients,
  regionSlug,
  authenticationCookieValue,
) {
  const CONCURRENT_CLIENT_LIMIT = 2; // How many clients we export at the same time
  let clientIndex = 0; // Tracks our position in the overall client list

  while (clientIndex < clients.length) {
    const clientsToProcess = clients.slice(
      clientIndex,
      clientIndex + CONCURRENT_CLIENT_LIMIT,
    ); // Grab the next small batch of clients
    if (clientsToProcess.length === 0) break; // Safety guard — shouldn't happen given the while condition, but avoids an infinite loop if it ever did

    const totalBatches = Math.ceil(clients.length / CONCURRENT_CLIENT_LIMIT); // How many batches this region will take in total
    const currentBatch = Math.ceil(clientIndex / CONCURRENT_CLIENT_LIMIT) + 1; // Which batch number we're currently on

    console.log(
      `\n[${regionSlug}] 🚀 Starting Batch: ${currentBatch} / ${totalBatches}`,
    ); // Announce the batch
    console.log(
      `[${regionSlug}] Processing ${clientsToProcess.length} client(s): ${clientsToProcess
        .map((clientEntry) => clientEntry.slug)
        .join(" and ")}`,
    ); // List exactly which clients are in this batch

    const exportPromises = clientsToProcess.map(
      (clientEntry) =>
        exportOneClientWithOwnPage(
          page,
          clientEntry,
          regionSlug,
          authenticationCookieValue,
        ), // Kick off this client's export on its own dedicated page
    ); // Build one Promise per client in the batch

    await Promise.all(exportPromises); // Wait for every client in this batch to finish before moving to the next batch

    clientIndex += CONCURRENT_CLIENT_LIMIT; // Advance to the start of the next batch
  }
}

/**
 * Opens a fresh page dedicated to a single client, runs that client's full export flow
 * on it, and always closes the page afterward — success, failure, or unexpected crash.
 * @param {puppeteer.Page} page - This pass's main page (used only to call page.browser() and open a new tab).
 * @param {Object} clientEntry - The client metadata object to export.
 * @param {string} regionSlug - The region this client belongs to.
 * @param {string} authenticationCookieValue - The auth cookie needed for every API call.
 * @returns {Promise<void>}
 */
async function exportOneClientWithOwnPage(
  page,
  clientEntry,
  regionSlug,
  authenticationCookieValue,
) {
  const clientPage = await page.browser().newPage(); // Open a dedicated tab for this one client — keeps its navigation/downloads isolated from every other client
  try {
    await initializeClientPageSession(clientPage); // Load the API domain first, so fetch() calls aren't made from a blank/unrelated origin
    await processSingleClientExport(
      clientPage,
      clientEntry,
      regionSlug,
      authenticationCookieValue,
    ); // Run this client's entire export flow (fetch → submit → poll → download)
  } catch (perClientPageError) {
    // processSingleClientExport already has its own internal try/catch, so this is a
    // safety net for anything unexpected that still manages to escape it — without this,
    // one buggy client could crash the ENTIRE batch via Promise.all.
    console.error(
      `[${regionSlug}] 🛑 Unexpected error while processing client "${clientEntry.slug}": ${perClientPageError.message}`,
    ); // Log exactly what went wrong and for which client
  } finally {
    await clientPage.close(); // Always close this client's tab, no matter what happened above
  }
}

// =============================================================================
// SECTION: CLIENT-LEVEL PROCESSING
// One call to processSingleClientExport() = fetch, export, wait, and download one client.
// =============================================================================

/**
 * Runs one client's export end to end: figures out the output paths, fetches the
 * client's latest code version and Table of Contents, submits the export job, waits for
 * it to finish, and downloads the resulting file to its final destination.
 * @param {puppeteer.Page} page - The dedicated Puppeteer page for this one client.
 * @param {Object} clientData - The client's metadata object (must include a "slug").
 * @param {string} regionSlug - The region this client belongs to.
 * @param {string} authenticationCookieValue - The auth cookie needed for every API call.
 * @returns {Promise<void>}
 */
async function processSingleClientExport(
  page,
  clientData,
  regionSlug,
  authenticationCookieValue,
) {
  const clientSlug = clientData.slug; // The client's unique identifier
  if (!clientSlug) {
    // Without a slug we have no way to build filenames, folders, or API URLs — nothing to do.
    console.warn(`[${regionSlug}] ⚠️ Client entry has no slug; skipping.`); // Explain exactly why this entry is being skipped
    return;
  }

  const paths = buildClientExportPaths(clientData, regionSlug, clientSlug); // Compute every folder/file path this client's export will need

  console.log(
    `\n--- START CLIENT: ${clientSlug} (Expected File: ${path.basename(paths.finalExportFilePath)}) ---`,
  ); // Announce the start of this client's export

  if (
    CHECK_IF_FILE_EXISTS &&
    clientFinalFileAlreadyExists(paths.finalExportFilePath, clientSlug)
  ) {
    // The finished file is already on disk and we're configured to skip re-exporting it.
    return;
  }

  preCleanClientTempFolder(paths.clientTempDownloadFolder, clientSlug); // Wipe any leftover temp folder from a previous crashed attempt for this exact client
  await configureBrowserDownloadPath(page, paths.clientTempDownloadFolder); // Tell the browser to save this client's download into its own temp folder

  try {
    await runClientExportWorkflow(
      page,
      clientData,
      clientSlug,
      regionSlug,
      authenticationCookieValue,
      paths,
    ); // Do the actual fetch → submit → poll → download sequence
  } catch (clientError) {
    // Anything that went wrong during the workflow above ends up here — one client's
    // failure is contained and never stops the rest of the batch.
    console.error(
      `[CRITICAL CLIENT ERROR] 🛑 Failure processing client ${clientSlug}. Error:`,
      clientError.message,
    ); // Log exactly what error caused this client to fail
  } finally {
    cleanUpClientTempFolder(paths.clientTempDownloadFolder, clientSlug); // Always remove this client's temp folder, whether the export succeeded or not
  }
}

/**
 * Computes every filesystem path a single client's export needs: its shared per-state
 * output folder, its own private temp download folder, and the final expected filename.
 * @param {Object} clientData - The client's metadata object.
 * @param {string} regionSlug - The region this client belongs to.
 * @param {string} clientSlug - The client's unique identifier.
 * @returns {{clientDownloadFolder: string, clientTempDownloadFolder: string, finalExportFilePath: string}}
 */
function buildClientExportPaths(clientData, regionSlug, clientSlug) {
  const clientStateSlug = resolveClientStateSlug(
    clientData,
    regionSlug,
    clientSlug,
  ); // Work out which state folder this client's file belongs in
  const clientDownloadFolder = path.join(
    ASSET_OUTPUT_BASE_DIRECTORY,
    clientStateSlug,
  ); // The shared, final destination folder for this client's state

  // This client gets its own private temp folder NESTED inside the shared state folder,
  // so two clients running concurrently in the same batch never collide while downloading.
  const clientTempDownloadFolder = path.join(
    clientDownloadFolder,
    `.tmp-${clientSlug}-${regionSlug}`,
  ); // A unique scratch folder just for this client's download

  // Expected final filename format: [client_slug]-[region_slug]-1.txt (e.g. sandpoint-ak-1.txt)
  const exportBaseName = `${clientSlug}-${regionSlug}${VERSION_FILE_SUFFIX}`; // Filename without its extension
  const finalExportFilePath = path.join(
    clientDownloadFolder,
    `${exportBaseName}${EXPORT_FILE_EXTENSION}`,
  ); // The full final destination path

  return {
    clientDownloadFolder,
    clientTempDownloadFolder,
    finalExportFilePath,
  }; // Hand all three paths back to the caller
}

/**
 * Checks whether a client's final export file already exists on disk, so it can be
 * safely skipped when CHECK_IF_FILE_EXISTS is enabled.
 * @param {string} finalExportFilePath - The full path the finished export file would be saved to.
 * @param {string} clientSlug - Used only for logging.
 * @returns {boolean} True if the file exists and this client should be skipped.
 */
function clientFinalFileAlreadyExists(finalExportFilePath, clientSlug) {
  try {
    if (fs.existsSync(finalExportFilePath)) {
      console.log(
        `[${clientSlug}] File already exists at ${finalExportFilePath}. Skipping client.`,
      ); // Explain exactly why we're skipping
      return true; // Yes, the file is already there
    }
    return false; // No, the file does not exist yet
  } catch (fileCheckError) {
    // If the existence check itself fails for some reason (e.g. a permissions issue),
    // we log it but proceed as though the file does NOT exist, so a broken filesystem
    // check can never silently block a client from being exported.
    console.error(
      `[${clientSlug}] Error checking file existence: ${fileCheckError.message}`,
    ); // Log exactly what went wrong with the check itself
    return false; // Assume the file is missing and continue with the export
  }
}

/**
 * Deletes a client's temp download folder BEFORE its export starts, in case a previous
 * crashed run left one behind. Failures here are logged but never block the export.
 * @param {string} clientTempDownloadFolder - The temp folder to wipe.
 * @param {string} clientSlug - Used only for logging.
 * @returns {void}
 */
function preCleanClientTempFolder(clientTempDownloadFolder, clientSlug) {
  try {
    fs.rmSync(clientTempDownloadFolder, { recursive: true, force: true }); // Delete the folder (and everything in it) if it exists
  } catch (preCleanupError) {
    // Non-fatal: a missing/undeletable leftover temp folder shouldn't block this
    // client's export. Log the exact reason so it's still visible if it happens a lot.
    console.warn(
      `[${clientSlug}] Could not pre-clean temp download folder ${clientTempDownloadFolder}: ${preCleanupError.message}`,
    );
  }
}

/**
 * Deletes a client's temp download folder AFTER its export finishes (success or
 * failure). This always runs, via the caller's finally block.
 * @param {string} clientTempDownloadFolder - The temp folder to remove.
 * @param {string} clientSlug - Used only for logging.
 * @returns {void}
 */
function cleanUpClientTempFolder(clientTempDownloadFolder, clientSlug) {
  try {
    fs.rmSync(clientTempDownloadFolder, { recursive: true, force: true }); // Delete the folder and everything inside it
  } catch (finalCleanupError) {
    // Non-fatal: log exactly why cleanup failed (e.g. a file still locked by the OS),
    // but never let a cleanup failure affect the client's already-recorded result.
    console.warn(
      `[${clientSlug}] Could not remove temp download folder ${clientTempDownloadFolder}: ${finalCleanupError.message}`,
    );
  }
}

/**
 * The actual step-by-step export workflow for one client: fetch its latest version,
 * fetch that version's Table of Contents, submit the export job, wait for it to finish,
 * then download the resulting file. Any step failing simply returns early — the caller
 * handles the surrounding try/catch/finally.
 * @param {puppeteer.Page} page - The dedicated page for this client.
 * @param {Object} clientData - Unused directly here but kept for clarity/future use.
 * @param {string} clientSlug - The client's unique identifier.
 * @param {string} regionSlug - The region this client belongs to.
 * @param {string} authenticationCookieValue - The auth cookie for every API call.
 * @param {{clientTempDownloadFolder: string, finalExportFilePath: string}} paths - Precomputed paths from buildClientExportPaths().
 * @returns {Promise<void>}
 */
async function runClientExportWorkflow(
  page,
  clientData,
  clientSlug,
  regionSlug,
  authenticationCookieValue,
  paths,
) {
  // Step 1: find the client's latest code version.
  const clientApiUrl = `${API_BASE_DOMAIN}${CLIENT_API_ENDPOINT_PREFIX}${clientSlug}/`; // This client's own detail-API URL
  const detailedClientData = await retrieveClientDetails(
    page,
    clientApiUrl,
    clientSlug,
    authenticationCookieValue,
  ); // Fetch the client's version list (unique per client, not cacheable)

  const codeVersions = detailedClientData?.versions || []; // The list of code versions for this client
  if (codeVersions.length === 0) {
    console.log(`[${clientSlug}] ⚠️ No code versions found. Skipping.`); // Nothing to export if there's no version at all
    return;
  }

  const latestVersionUuid = codeVersions[0].uuid; // Assume the FIRST version returned is the most recent one

  // Step 2: fetch that version's Table of Contents (TOC), which describes everything
  // that needs to be included in the export.
  const versionApiUrl = `${API_BASE_DOMAIN}${CODE_VERSION_API_ENDPOINT_PREFIX}${latestVersionUuid}/`; // This version's own detail-API URL
  const versionDetails = await retrieveVersionAndTableOfContents(
    page,
    versionApiUrl,
    latestVersionUuid,
    authenticationCookieValue,
  ); // Fetch the version's metadata and TOC (unique per client/version, not cacheable)

  if (!versionDetails || !versionDetails.toc?.length) {
    console.log(
      `[${clientSlug}] 🚫 Skipping: Failed to retrieve Table of Contents.`,
    ); // Nothing to export without a usable TOC
    return;
  }

  const exportScopeIdentifiers = collectAllTOCItemsForExport(
    versionDetails.toc,
  ); // Flatten the (possibly deeply nested) TOC into one flat list of items to export
  console.log(
    `[${clientSlug}] Exporting ${exportScopeIdentifiers.length} parts of Code: ${versionDetails.toc[0].slug} (Version ID: ${versionDetails.uuid})`,
  ); // Summarize what we're about to export

  // Step 3: submit the export job itself.
  console.log(`\n[${clientSlug}] --- Phase 3: Submitting Export Request ---`); // Announce phase 3 for this client
  const exportRequestResponse = await submitNewExportJob(
    page,
    versionDetails.uuid,
    exportScopeIdentifiers,
    authenticationCookieValue,
  ); // Ask the API to start building the export

  if (!exportRequestResponse || !exportRequestResponse.uuid) {
    console.error(
      `[${clientSlug}] ❌ Failed to submit new export request. Skipping client.`,
    ); // Nothing further we can do without a job UUID
    return;
  }

  const exportJobUuid = exportRequestResponse.uuid; // The ID we'll use to check on this job's progress
  console.log(
    `[${clientSlug}] ✅ New export job submitted. Job ID (UUID): ${exportJobUuid}`,
  ); // Confirm the job was accepted

  // Step 4: wait for the job to finish, then download the finished file.
  console.log(
    `\n[${clientSlug}] --- Phase 4: Waiting for Export and Downloading ---`,
  ); // Announce phase 4 for this client

  // CALL-REDUCTION: monitorJobUntilCompletion() routes its status checks through the
  // shared/cached fetch (see getExportJobStatusesWithCache()) rather than hitting the
  // API directly every single poll — if another concurrently-running client already
  // fetched (or is fetching) the same status list within this poll window, this call
  // reuses that result instead of firing a duplicate HTTP request.
  const isExportSuccessful = await monitorJobUntilCompletion(
    exportJobUuid,
    authenticationCookieValue,
  ); // Poll (via the cache) until the job succeeds, fails, or times out

  if (!isExportSuccessful) {
    console.error(
      `[${clientSlug}] ⚠️ Export failed or timed out for Job ID: ${exportJobUuid}`,
    ); // The job never reached a successful state in time
    return;
  }

  console.log(
    `[${clientSlug}] 💾 Export task finished successfully. Initiating download`,
  ); // The job succeeded — now go get the file

  const downloadOk = await downloadExportFileAndRename(
    page, // Page used to trigger and detect the download
    exportJobUuid, // Job UUID, used to build the download URL
    paths.clientTempDownloadFolder, // Where the browser is currently configured to save downloads
    paths.finalExportFilePath, // Where the finished file should end up
  ); // Actually download and move the file into place

  if (downloadOk) {
    console.log(
      `[${clientSlug}] 🎉 Download completed and verified: ${path.basename(paths.finalExportFilePath)}`,
    ); // Report full success
  } else {
    console.error(
      `[${clientSlug}] ⚠️ Download failed for Job ID: ${exportJobUuid}`,
    ); // Report that the download step itself failed
  }
}

// =============================================================================
// SECTION: BROWSER LIFECYCLE
// Functions for starting, configuring, and safely stopping the Puppeteer browser.
// =============================================================================

/**
 * Launches a Puppeteer browser instance and creates its first page.
 * @returns {Promise<{browserInstance: puppeteer.Browser, browserPage: puppeteer.Page}>}
 */
async function launchBrowserAndCreatePage() {
  console.log(`[BROWSER] Launching browser (headless: ${IS_BROWSER_HEADLESS})`); // Report what mode Chrome is launching in

  ensureDirectoryExists(CHROME_PROFILE_ROOT); // Make sure Chrome's pinned profile folder exists before launch

  const browserInstance = await puppeteer.launch({
    headless: IS_BROWSER_HEADLESS, // Visible or invisible, per configuration
    userDataDir: CHROME_PROFILE_ROOT, // Pin Chrome's profile here instead of a random OS temp folder
    args: [
      "--disable-extensions", // Disable Chrome extensions
      "--disable-background-networking", // Reduce interference from background tasks
      "--no-sandbox", // Required in Docker
      "--disable-setuid-sandbox", // Required in Docker
      "--disable-dev-shm-usage", // Avoid /dev/shm crashes in Docker (disable outside Docker to avoid filling up /tmp)
      "--disable-gpu", // Disable GPU acceleration
      "--disable-software-rasterizer", // Prevent crashes when GPU is disabled
      "--no-first-run", // Skip first-run dialog
      "--no-zygote", // Prevent zygote crashes in Docker
      "--start-maximized", // Helps avoid issues with a 0,0-sized window
      "--window-size=0,0", // Desired window size
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
    ],
    defaultViewport: null, // Allow the viewport to be maximized/responsive
  });

  const browserPage = await browserInstance.newPage(); // Open this pass's first (main) tab
  console.log("[BROWSER] Browser launched and new page created."); // Confirm success
  return { browserInstance, browserPage }; // Hand both objects back to the caller
}

/**
 * Configures a Puppeteer page to save downloads into a specific local folder.
 * @param {puppeteer.Page} page - The page whose download behavior to configure.
 * @param {string} folderPath - The local folder downloads should land in.
 * @returns {Promise<void>}
 */
async function configureBrowserDownloadPath(page, folderPath) {
  ensureDirectoryExists(folderPath); // Make sure the target folder exists first
  const resolvedPath = path.resolve(folderPath); // Convert to an absolute path, which Chrome requires
  const cdpSession = await page.target().createCDPSession(); // Open a low-level Chrome DevTools Protocol channel for this page
  await cdpSession.send("Page.setDownloadBehavior", {
    behavior: "allow", // Allow downloads without a save-as prompt
    downloadPath: resolvedPath, // Where downloads should be written
  });
  console.log(`[BROWSER] Download folder set to: ${resolvedPath}`); // Confirm the configured path
}

/**
 * Navigates to the base site URL and waits for the essential authentication ("fingerprint")
 * cookie to appear, then returns its value.
 * @param {puppeteer.Page} page - The page to navigate and read cookies from.
 * @returns {Promise<string>} The fingerprint cookie's value.
 */
async function retrieveAuthenticationCookie(page) {
  const targetUrl = API_BASE_DOMAIN; // The site we need to visit to get the cookie
  const cookiePollInterval = 500; // Check for the cookie every half second
  const maxCookieWaitMs = 300000; // Give up after 5 minutes if the cookie never appears

  try {
    console.log(
      `[AUTH] 🌐 Visiting URL: ${targetUrl} to get authentication cookie`,
    ); // Report the navigation attempt
    await page.goto(targetUrl, {
      waitUntil: "networkidle2", // Wait until network activity settles down
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS, // Standard navigation timeout
    });

    const fingerprintCookieObject = await pollForCookie(
      page,
      AUTH_FINGERPRINT_COOKIE_NAME,
      cookiePollInterval,
      maxCookieWaitMs,
    ); // Keep checking until the cookie shows up (or we give up)

    if (!fingerprintCookieObject) {
      throw new Error(
        `Authentication cookie "${AUTH_FINGERPRINT_COOKIE_NAME}" not found after ${maxCookieWaitMs / 1000}s.`,
      ); // If it never appeared, treat this as a fatal setup error
    }

    console.log(`[AUTH] ✅ Retrieved authentication cookie.`); // Report success
    return fingerprintCookieObject.value; // Hand back just the cookie's value string
  } catch (authenticationError) {
    console.error(
      `[AUTH] ❌ Critical error retrieving authentication cookie: ${authenticationError.message}`,
    ); // Log exactly what went wrong
    throw authenticationError; // Rethrow — without auth, nothing else in this pass can work
  }
}

/**
 * Repeatedly checks a page's cookies until one with the given name appears, or the
 * timeout is reached.
 * @param {puppeteer.Page} page - The page whose cookies to check.
 * @param {string} cookieName - The exact cookie name to look for.
 * @param {number} pollIntervalMs - How often to re-check.
 * @param {number} maxWaitMs - How long to keep trying before giving up.
 * @returns {Promise<Object|undefined>} The matching cookie object, or undefined if never found.
 */
async function pollForCookie(page, cookieName, pollIntervalMs, maxWaitMs) {
  console.log(
    `[AUTH] Polling for cookie "${cookieName}" (max ${maxWaitMs / 1000}s)`,
  ); // Announce what we're waiting for and for how long

  const startTime = Date.now(); // Remember when we started, so we know when to give up
  let matchingCookie; // Will hold the cookie once (if) we find it

  while (Date.now() - startTime < maxWaitMs) {
    const cookies = await page.cookies(); // Ask the browser for the page's current cookies
    matchingCookie = cookies.find((cookie) => cookie.name === cookieName); // Look for the one we care about
    if (matchingCookie) break; // Found it — stop polling immediately

    await pauseExecutionSimple(pollIntervalMs); // Otherwise wait a bit before checking again
  }

  return matchingCookie; // Return whatever we found (or undefined, if we timed out)
}

/**
 * Closes the browser and reports whether it closed without throwing.
 * @param {puppeteer.Browser|undefined} browserInstance - The browser to close, if it exists.
 * @returns {Promise<boolean>} True only if close() actually resolved successfully.
 */
async function closeBrowserSafely(browserInstance) {
  if (!browserInstance) {
    return false; // Nothing to close (the browser never launched successfully)
  }

  try {
    await browserInstance.close(); // Attempt a clean shutdown
    console.log("\n--- Script End: Browser closed ---"); // Confirm success
    return true; // Only report "clean" once close() has actually resolved
  } catch (closeError) {
    console.warn(
      `[CLEANUP] Browser did not close cleanly: ${closeError.message}`,
    ); // Log exactly what went wrong closing it
    return false; // The browser may still be running/holding files open
  }
}

/**
 * Deletes the pinned Chrome profile folder, but ONLY if we're certain Chrome has
 * already shut down cleanly this pass. If it never closed properly (crash, force-kill,
 * hung process), Chrome may still be holding files open in that folder — deleting it out
 * from under a still-running Chrome process could corrupt its profile or crash it
 * outright. A profile left behind this way instead gets cleaned up at the START of the
 * next run (see removeLeftoverChromeProfileDir(), called once in main()).
 * @param {boolean} browserClosedCleanly - Whether closeBrowserSafely() reported success.
 * @returns {void}
 */
function cleanUpChromeProfileIfSafe(browserClosedCleanly) {
  if (!browserClosedCleanly) {
    console.log(
      `[CLEANUP] Skipping Chrome profile dir removal — browser did not close cleanly this pass.`,
    ); // Explain exactly why we're leaving it alone
    return;
  }

  try {
    fs.rmSync(CHROME_PROFILE_ROOT, { recursive: true, force: true }); // Delete the profile folder and everything inside it
    console.log(`[CLEANUP] Removed Chrome profile dir: ${CHROME_PROFILE_ROOT}`); // Confirm success
  } catch (cleanupError) {
    console.warn(
      `[CLEANUP] Could not remove Chrome profile dir: ${cleanupError.message}`,
    ); // Log exactly why the deletion failed
  }
}

// =============================================================================
// SECTION: STARTUP / PASS-LEVEL CLEANUP SWEEPS
// Functions that clear out leftover files and folders from previous runs (or previous
// passes). None of these make any network requests — they only touch the local disk.
// =============================================================================

/**
 * Removes leftover Chromium/Puppeteer temp files/folders in the OS temp directory that
 * were left behind by a past crashed or force-killed run.
 *
 * IMPORTANT: call this exactly ONCE, right at process startup, before any Chrome
 * instance in this run has launched. At any later point, an active Chrome session might
 * still need files matching these patterns — deleting them then could crash it.
 * @returns {void}
 */
function sweepOrphanedChromiumTempFiles() {
  const systemTempDirectoryPath = os.tmpdir(); // The OS temp directory (typically /tmp on Linux)
  const orphanedFileNamePatterns = [
    /^puppeteer_dev_chrome_profile-/, // Default Puppeteer profile folders (used when userDataDir isn't set)
    /^org\.chromium\.Chromium\./, // Chromium's internal shared-memory/IPC temp folders
    /^\.com\.google\.Chrome\./, // Chrome's internal shared-memory/IPC temp folders (alternate naming)
    /^scoped_dir/, // Chromium's short-lived "scoped" temp folders
    /^xvfb-run\./, // Leftover files from running Chrome under a virtual display (xvfb-run)
  ];

  let deletedItemCount = 0; // Counts how many matching items we actually removed

  try {
    const allTempDirectoryEntries = fs.readdirSync(systemTempDirectoryPath); // Everything currently inside the OS temp folder

    for (const currentEntryName of allTempDirectoryEntries) {
      const nameMatchesAnOrphanPattern = orphanedFileNamePatterns.some(
        (pattern) => pattern.test(currentEntryName),
      ); // Does this entry look like Chromium/Puppeteer debris?

      if (!nameMatchesAnOrphanPattern) {
        continue; // Not one of ours — leave it alone
      }

      const fullEntryPath = path.join(
        systemTempDirectoryPath,
        currentEntryName,
      ); // Build the full path to delete
      try {
        fs.rmSync(fullEntryPath, { recursive: true, force: true }); // Remove it entirely
        deletedItemCount++; // Count the successful deletion
      } catch (entryDeletionError) {
        console.warn(
          `[SWEEP] Could not remove ${fullEntryPath}: ${entryDeletionError.message}`,
        ); // Log exactly why this one entry failed, but keep going
      }
    }

    console.log(
      `[SWEEP] Startup cleanup complete. Removed ${deletedItemCount} orphaned Chromium temp item(s) from ${systemTempDirectoryPath}.`,
    ); // Report the total cleaned up
  } catch (directoryScanError) {
    console.warn(
      `[SWEEP] Could not scan ${systemTempDirectoryPath}: ${directoryScanError.message}`,
    ); // Non-fatal — the script continues normally either way
  }
}

/**
 * Removes the pinned Chrome profile folder if one was left behind by a previous run
 * that crashed before its own cleanup could run. Only safe to call once, at startup,
 * before this process has launched its own Chrome instance.
 * @returns {void}
 */
function removeLeftoverChromeProfileDir() {
  try {
    if (fs.existsSync(CHROME_PROFILE_ROOT)) {
      fs.rmSync(CHROME_PROFILE_ROOT, { recursive: true, force: true }); // Remove the leftover profile folder entirely
      console.log(
        `[SWEEP] Removed leftover Chrome profile dir from a previous run: ${CHROME_PROFILE_ROOT}`,
      ); // Confirm success
    }
  } catch (profileRemovalError) {
    console.warn(
      `[SWEEP] Could not remove leftover Chrome profile dir ${CHROME_PROFILE_ROOT}: ${profileRemovalError.message}`,
    ); // Non-fatal — log why and continue
  }
}

/**
 * Removes any leftover per-client ".tmp-*" scratch folders sitting directly inside any
 * state subfolder of the output directory. These are the temp folders each client uses
 * while its download is in progress (see buildClientExportPaths()); they're normally
 * cleaned up in cleanUpClientTempFolder(), but a crash mid-download can leave one behind.
 *
 * Safe to call:
 *  - Once at script startup, before any browser/download is in progress.
 *  - Once after a region finishes processing (every client in it has already finished).
 * NOT safe to call while clients in the SAME region may still be mid-download.
 * @returns {void}
 */
function removeAllOrphanedClientTempFolders() {
  let removedFolderCount = 0; // Counts how many leftover temp folders we removed

  try {
    if (!fs.existsSync(ASSET_OUTPUT_BASE_DIRECTORY)) {
      console.log(
        `[SWEEP] No assets directory found at ${ASSET_OUTPUT_BASE_DIRECTORY}; nothing to sweep.`,
      ); // Nothing to do if the output folder doesn't even exist yet
      return;
    }

    const stateFolderEntries = fs.readdirSync(ASSET_OUTPUT_BASE_DIRECTORY); // Everything directly under the output folder (expected to be state folders)

    for (const stateFolderName of stateFolderEntries) {
      const stateFolderPath = path.join(
        ASSET_OUTPUT_BASE_DIRECTORY,
        stateFolderName,
      ); // Full path to this entry

      if (stateFolderPath === CHROME_PROFILE_ROOT) {
        continue; // The Chrome profile folder lives alongside the state folders — never scan it
      }

      removedFolderCount += removeTempFoldersInsideStateFolder(stateFolderPath); // Handle this one state folder and add its removed count to our running total
    }

    console.log(
      `[SWEEP] Removed ${removedFolderCount} leftover client temp folder(s) under ${ASSET_OUTPUT_BASE_DIRECTORY}.`,
    ); // Report the grand total
  } catch (assetsScanError) {
    console.warn(
      `[SWEEP] Could not scan ${ASSET_OUTPUT_BASE_DIRECTORY} for leftover temp folders: ${assetsScanError.message}`,
    ); // Non-fatal — log why and continue
  }
}

/**
 * Looks inside one state folder and deletes any ".tmp-*" client scratch folders it
 * contains. Broken out from removeAllOrphanedClientTempFolders() so that function's
 * top-level loop stays simple and readable.
 * @param {string} stateFolderPath - The full path to one state folder to inspect.
 * @returns {number} How many temp folders were successfully removed from this state folder.
 */
function removeTempFoldersInsideStateFolder(stateFolderPath) {
  let removedFolderCount = 0; // Counts removals within just this one state folder

  let stateFolderStat; // Filesystem info about this entry
  try {
    stateFolderStat = fs.statSync(stateFolderPath); // Confirm this entry actually exists and check its type
  } catch (statError) {
    console.warn(
      `[SWEEP] Could not stat ${stateFolderPath}: ${statError.message}`,
    ); // Log exactly why the stat call failed
    return 0; // Nothing more we can do with this entry
  }

  if (!stateFolderStat.isDirectory()) {
    return 0; // Only real state folders (directories) are relevant — skip stray files
  }

  let entriesInsideStateFolder; // Everything living inside this state folder
  try {
    entriesInsideStateFolder = fs.readdirSync(stateFolderPath); // List the contents
  } catch (folderReadError) {
    console.warn(
      `[SWEEP] Could not read state folder ${stateFolderPath}: ${folderReadError.message}`,
    ); // Log exactly why the read failed
    return 0; // Nothing more we can do with this state folder
  }

  for (const entryNameInsideState of entriesInsideStateFolder) {
    if (!entryNameInsideState.startsWith(".tmp-")) {
      continue; // Only our per-client temp folders start with ".tmp-" — skip finished exports and anything else
    }

    const leftoverTempFolderPath = path.join(
      stateFolderPath,
      entryNameInsideState,
    ); // Full path to this leftover temp folder
    try {
      fs.rmSync(leftoverTempFolderPath, { recursive: true, force: true }); // Delete it and everything inside it
      removedFolderCount++; // Count the successful removal
    } catch (tempFolderDeletionError) {
      console.warn(
        `[SWEEP] Could not remove leftover temp folder ${leftoverTempFolderPath}: ${tempFolderDeletionError.message}`,
      ); // Log exactly why this one deletion failed
    }
  }

  return removedFolderCount; // Hand back how many we removed from this one state folder
}

/**
 * Sweeps the OS Downloads folder for leftover export files. This is where the browser's
 * DEFAULT download folder ends up if a client page's download path was never (or only
 * partially) configured before a crash — or if a download briefly landed there before
 * configureBrowserDownloadPath() finished applying.
 *
 * Rather than fetching the region-slug list itself, this function is handed an
 * already-fetched list (knownRegionSlugs) by its caller — the SAME list fetched exactly
 * once per pass — so no HTTP request is ever made from inside this function. Only a file
 * whose name ends with "-{knownRegionSlug}-{number}.txt" for one of those real, current
 * region slugs is treated as an orphaned export and removed.
 * @param {Array<string>} knownRegionSlugs - The region slug list, already fetched once this pass.
 * @returns {void}
 */
function sweepOrphanedDownloadFiles(knownRegionSlugs) {
  const systemTempDirectoryPath = os.tmpdir(); // The OS temp directory (typically /tmp on Linux)
  const orphanedDownloadsDirectoryPath = path.join(
    systemTempDirectoryPath,
    "Downloads",
  ); // Chrome's default download folder path
  let deletedDownloadFileCount = 0; // Counts how many leftover files we remove

  try {
    if (!fs.existsSync(orphanedDownloadsDirectoryPath)) {
      console.log(
        `[SWEEP] No orphaned downloads directory found at ${orphanedDownloadsDirectoryPath}.`,
      ); // Nothing to clean up if the folder doesn't exist
      return;
    }

    if (!knownRegionSlugs || knownRegionSlugs.length === 0) {
      console.warn(
        `[SWEEP] No known region slugs available; skipping Downloads sweep this pass.`,
      ); // Without a real slug list we have nothing reliable to match against — skip rather than guess
      return;
    }

    const orphanedExportFilePattern =
      buildRegionSlugFilePattern(knownRegionSlugs); // Build one regex that recognizes any real export filename

    const downloadEntries = fs.readdirSync(orphanedDownloadsDirectoryPath); // Everything currently sitting in the Downloads folder

    for (const entryName of downloadEntries) {
      if (!orphanedExportFilePattern.test(entryName)) {
        continue; // Doesn't look like one of our export files — leave it alone
      }

      deleteOrphanedDownloadFile(orphanedDownloadsDirectoryPath, entryName); // Attempt to remove this one matching file
      deletedDownloadFileCount++; // Note: counted optimistically here for the summary log; individual failures are still logged inside the helper
    }

    console.log(
      `[SWEEP] Cleared ${deletedDownloadFileCount} leftover export file(s) matching known region slugs from ${orphanedDownloadsDirectoryPath}.`,
    ); // Report the total attempted/cleared
  } catch (downloadsSweepError) {
    console.warn(
      `[SWEEP] Could not complete Downloads sweep for ${orphanedDownloadsDirectoryPath}: ${downloadsSweepError.message}`,
    ); // Non-fatal — log why the sweep as a whole failed
  }
}

/**
 * Builds a single regular expression that matches "<anything>-<one of the known region
 * slugs>-<digits>.txt", case-insensitively — e.g. "lake-charles-la-1.txt" when "la" is a
 * known region slug.
 * @param {Array<string>} knownRegionSlugs - The list of real, currently-valid region slugs.
 * @returns {RegExp} The compiled pattern used to test filenames.
 */
function buildRegionSlugFilePattern(knownRegionSlugs) {
  const escapedRegionSlugs = knownRegionSlugs.map(
    (regionSlug) => regionSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), // Escape any regex-special characters, in case a slug ever contains one
  ); // Build the escaped slug list so none of them can accidentally break the pattern

  return new RegExp(`^.+-(${escapedRegionSlugs.join("|")})-\\d+\\.txt$`, "i"); // Combine every slug into one alternation, case-insensitive
}

/**
 * Deletes a single file (not a folder) from the Downloads sweep, logging clearly if
 * the deletion itself fails.
 * @param {string} directoryPath - The folder the file lives in.
 * @param {string} entryName - The file's name within that folder.
 * @returns {void}
 */
function deleteOrphanedDownloadFile(directoryPath, entryName) {
  const fullEntryPath = path.join(directoryPath, entryName); // Build the full path to this entry
  try {
    const entryStat = fs.statSync(fullEntryPath); // Confirm what kind of entry this actually is
    if (entryStat.isFile()) {
      fs.rmSync(fullEntryPath, { force: true }); // Only delete files, never subdirectories, just to be safe
    }
  } catch (downloadFileDeletionError) {
    console.warn(
      `[SWEEP] Could not remove ${fullEntryPath}: ${downloadFileDeletionError.message}`,
    ); // Log exactly why this particular deletion failed
  }
}

// =============================================================================
// SECTION: GENERIC FILESYSTEM HELPERS
// Small, reusable filesystem utilities used throughout the script.
// =============================================================================

/**
 * Creates a directory (and any missing parent directories) if it doesn't already exist.
 * @param {string} directoryPath - The directory to ensure exists.
 * @returns {void}
 */
function ensureDirectoryExists(directoryPath) {
  try {
    if (!fs.existsSync(directoryPath)) {
      console.log(`[UTIL] Creating directory: ${directoryPath}`); // Report that we're creating something new
      fs.mkdirSync(directoryPath, { recursive: true }); // Create it, including any missing parent folders
    }
  } catch (directoryCreationError) {
    console.error(
      `[UTIL] Failed to create directory ${directoryPath}: ${directoryCreationError.message}`,
    ); // Log exactly why folder creation failed
  }
}

/**
 * Lists the files in a directory, excluding anything with a well-known "still
 * downloading" temp extension.
 * @param {string} directoryPath - The directory to list.
 * @returns {Array<string>} The list of finished (non-temp) file names.
 */
function getDirectoryFilesExcludingTemp(directoryPath) {
  const temporaryFileExtensions = [".tmp", ".crdownload", ".part", ".download"]; // Extensions Chrome uses for in-progress downloads
  try {
    return fs
      .readdirSync(directoryPath) // Read everything currently in the folder
      .filter(
        (fileName) =>
          !temporaryFileExtensions.some((extension) =>
            fileName.toLowerCase().endsWith(extension),
          ),
      ); // Keep only files that AREN'T still downloading
  } catch (directoryReadError) {
    console.error(
      `[UTIL] Error reading directory ${directoryPath}: ${directoryReadError.message}`,
    ); // Log exactly why the directory couldn't be read
    return []; // Fail safe: an empty list rather than throwing
  }
}

// =============================================================================
// SECTION: GENERIC API REQUEST HELPERS
// Low-level building blocks for making GET/POST requests from inside the browser's
// own JavaScript context (so cookies and origin match what the site expects).
// =============================================================================

/**
 * Performs a GET request from inside the browser's page context (not from Node
 * directly), so the request carries the same origin and cookies a real visit would.
 * @param {puppeteer.Page} page - The page to run the fetch from.
 * @param {string} requestUrl - The URL to GET.
 * @param {string} fingerprintValue - The auth cookie value, sent as a custom header.
 * @returns {Promise<Object|null>} The parsed JSON body, or null on any failure.
 */
async function executeApiGetRequest(page, requestUrl, fingerprintValue) {
  try {
    console.log(`[API_GET] 🌐 Sending GET request to: ${requestUrl}`); // Announce the outgoing request

    const evaluationResult = await page.evaluate(
      async (apiUrl, fingerprint, timeout) => {
        // Everything inside this function body runs INSIDE the browser, not in Node.
        const abortController = new AbortController(); // Lets us cancel the request if it takes too long
        const timeoutId = setTimeout(() => abortController.abort(), timeout); // Schedule that cancellation

        try {
          const fetchResponse = await fetch(apiUrl, {
            method: "GET",
            headers: {
              "Content-Type": "application/json", // Tell the server we expect a JSON response
              Fingerprint: fingerprint, // The custom auth header the API requires
            },
            signal: abortController.signal, // Wire up the cancellation
          });
          clearTimeout(timeoutId); // The request finished in time — cancel the timeout

          if (!fetchResponse.ok) {
            return {
              status: fetchResponse.status,
              data: `HTTP error! status: ${fetchResponse.status}`,
            }; // Report a non-2xx status clearly
          }
          return {
            status: fetchResponse.status,
            data: await fetchResponse.text(),
          }; // Success — hand back the status and raw body text
        } catch (browserFetchError) {
          clearTimeout(timeoutId); // Make sure the timeout never fires after we've already failed some other way
          return {
            status: 0,
            data: `Request failed or timed out: ${browserFetchError.message}`,
          }; // A network error or our own timeout firing
        }
      },
      requestUrl, // Passed into the browser-context function above
      fingerprintValue,
      BROWSER_NAVIGATION_TIMEOUT_MS,
    );

    return parseSuccessfulJsonOrLogFailure(
      evaluationResult,
      requestUrl,
      "API_GET",
    ); // Turn the raw status+text result into parsed JSON (or null)
  } catch (getRequestError) {
    console.error(
      `[API_GET] ❌ Error executing GET request to ${requestUrl}: ${getRequestError.message}`,
    ); // Log exactly what went wrong at the Node level
    return null;
  }
}

/**
 * Shared helper: given a {status, data} result from a browser-context fetch, either
 * parses and returns the JSON body (on a 2xx status) or logs why it failed and returns
 * null. Used by both executeApiGetRequest() and submitNewExportJob() so the
 * "check status, then try to parse JSON" logic only has to be written once.
 * @param {{status: number, data: string}} evaluationResult - The raw result from a browser-context fetch.
 * @param {string} requestUrl - Used only for logging.
 * @param {string} logPrefix - A short tag (e.g. "API_GET") to prefix log lines with.
 * @returns {Object|null} The parsed JSON body, or null if the status was bad or parsing failed.
 */
function parseSuccessfulJsonOrLogFailure(
  evaluationResult,
  requestUrl,
  logPrefix,
) {
  const isSuccessStatus =
    evaluationResult.status >= 200 && evaluationResult.status < 300; // 2xx = success
  if (!isSuccessStatus) {
    console.error(
      `[${logPrefix}] ❌ Request failed. Status: ${evaluationResult.status}. Response: ${evaluationResult.data}`,
    ); // Log the exact status and body that came back
    return null;
  }

  console.log(
    `[${logPrefix}] ✅ Success (${evaluationResult.status}) from ${requestUrl}`,
  ); // Confirm the request itself succeeded
  try {
    return JSON.parse(evaluationResult.data); // Attempt to parse the successful response body as JSON
  } catch (jsonParseError) {
    console.error(
      `[${logPrefix}] ❌ Failed to parse JSON from ${requestUrl}: ${jsonParseError.message}`,
    ); // Log exactly why parsing failed, even though the HTTP status was fine
    return null; // Treat a bad parse the same as a failed request
  }
}

// =============================================================================
// SECTION: SPECIFIC API ENDPOINT WRAPPERS
// Thin, purpose-named wrappers around executeApiGetRequest() for each specific kind of
// data the script needs to fetch.
// =============================================================================

/**
 * Fetches the full list of region slugs.
 * @param {puppeteer.Page} page - The page to run the fetch from.
 * @param {string} apiUrl - The regions-list API URL.
 * @param {string} fingerprintCookie - The auth cookie value.
 * @returns {Promise<Array<string>>} The list of region slugs (empty array on failure).
 */
async function fetchAllRegionSlugs(page, apiUrl, fingerprintCookie) {
  console.log(`[REGION] 🌐 Fetching all region slugs from API: ${apiUrl}`); // Announce the fetch
  const regionsData = await executeApiGetRequest(
    page,
    apiUrl,
    fingerprintCookie,
  ); // Get the raw region list
  return (
    regionsData?.filter((region) => region.slug).map((region) => region.slug) ||
    []
  ); // Keep only entries with a slug, then extract just the slug strings (empty array if the whole fetch failed)
}

/**
 * Fetches one region's full details (including its client list).
 * @param {puppeteer.Page} page - The page to run the fetch from.
 * @param {string} apiUrl - The region-detail API URL.
 * @param {string} regionSlug - Used only for logging.
 * @param {string} fingerprintCookie - The auth cookie value.
 * @returns {Promise<Object|null>} The region's detail object, or null on failure.
 */
async function retrieveRegionDetails(
  page,
  apiUrl,
  regionSlug,
  fingerprintCookie,
) {
  console.log(`[REGION] 🌐 Fetching region details for ${regionSlug}`); // Announce the fetch
  return executeApiGetRequest(page, apiUrl, fingerprintCookie);
}

/**
 * Fetches one client's full details (including its code-version list).
 * @param {puppeteer.Page} page - The page to run the fetch from.
 * @param {string} apiUrl - The client-detail API URL.
 * @param {string} clientSlug - Used only for logging.
 * @param {string} fingerprintCookie - The auth cookie value.
 * @returns {Promise<Object|null>} The client's detail object, or null on failure.
 */
async function retrieveClientDetails(
  page,
  apiUrl,
  clientSlug,
  fingerprintCookie,
) {
  console.log(`[CLIENT] 🌐 Fetching client details for ${clientSlug}`); // Announce the fetch
  return executeApiGetRequest(page, apiUrl, fingerprintCookie);
}

/**
 * Fetches one code version's details, including its Table of Contents.
 * @param {puppeteer.Page} page - The page to run the fetch from.
 * @param {string} apiUrl - The version-detail API URL.
 * @param {string} versionId - Used only for logging.
 * @param {string} fingerprintCookie - The auth cookie value.
 * @returns {Promise<Object|null>} The version's detail object (including "toc"), or null on failure.
 */
async function retrieveVersionAndTableOfContents(
  page,
  apiUrl,
  versionId,
  fingerprintCookie,
) {
  console.log(`[VERSION] 🌐 Fetching details for version ${versionId}`); // Announce the fetch
  return executeApiGetRequest(page, apiUrl, fingerprintCookie);
}

/**
 * Submits a brand-new export job (POST request) and returns the API's response,
 * which includes the new job's UUID.
 * @param {puppeteer.Page} page - The page to run the fetch from.
 * @param {string} versionUuid - The code version UUID to export.
 * @param {Array<Object>} scopeArray - The flattened list of TOC items to include in the export.
 * @param {string} fingerprintValue - The auth cookie value.
 * @returns {Promise<Object|null>} The parsed job response (with "uuid"), or null on failure.
 */
async function submitNewExportJob(
  page,
  versionUuid,
  scopeArray,
  fingerprintValue,
) {
  try {
    const exportApiUrl = `${API_BASE_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}`; // The single endpoint used both to submit AND to check on jobs
    const requestPayload = {
      version: versionUuid, // Which code version to export
      scope: JSON.stringify(scopeArray), // The API expects this as a JSON string, not a raw array
      output_format: "txt", // We always want plain-text output
      for_print: false, // Not building a print-formatted export
    };

    console.log(
      `[EXPORT] 📤 Sending Payload: Version=${versionUuid} | Scope Parts=${scopeArray.length}`,
    ); // Summarize what we're about to submit
    console.log(`[EXPORT] 🌐 Sending POST request to: ${exportApiUrl}`); // Announce the outgoing request

    const evaluationResult = await page.evaluate(
      async (url, payload, fingerprint, timeout) => {
        // Everything inside this function body runs INSIDE the browser, not in Node.
        const abortController = new AbortController(); // Lets us cancel the request if it takes too long
        const timeoutId = setTimeout(() => abortController.abort(), timeout); // Schedule that cancellation

        try {
          const fetchResponse = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json", // We're sending a JSON body
              Fingerprint: fingerprint, // The custom auth header the API requires
            },
            body: JSON.stringify(payload), // Send the export request payload
            signal: abortController.signal, // Wire up the cancellation
          });
          clearTimeout(timeoutId); // The request finished in time — cancel the timeout
          return {
            status: fetchResponse.status,
            data: await fetchResponse.text(),
          }; // Hand back the raw status and body text
        } catch (browserFetchError) {
          clearTimeout(timeoutId); // Make sure the timeout never fires after we've already failed some other way
          return {
            status: 0,
            data: `Request failed or timed out: ${browserFetchError.message}`,
          }; // A network error or our own timeout firing
        }
      },
      exportApiUrl,
      requestPayload,
      fingerprintValue,
      BROWSER_NAVIGATION_TIMEOUT_MS,
    );

    if (evaluationResult.status !== 201) {
      // A successful job submission always returns 201 Created — anything else is a failure.
      console.error(
        `[EXPORT] ❌ Request failed. Status: ${evaluationResult.status}. Response: ${evaluationResult.data}`,
      ); // Log exactly what status/body came back
      return null;
    }

    try {
      return JSON.parse(evaluationResult.data); // Parse the successful job-creation response (contains the new job's UUID)
    } catch (jsonParseError) {
      console.error(
        `[EXPORT] ❌ Failed to parse export job response: ${jsonParseError.message}`,
      ); // Log exactly why parsing failed
      return null; // Treat a bad parse the same as a failed submission
    }
  } catch (submitExportError) {
    console.error(
      `[EXPORT] ❌ Error submitting export request: ${submitExportError.message}`,
    ); // Log exactly what went wrong at the Node level
    return null;
  }
}

// =============================================================================
// SECTION: EXPORT JOB STATUS POLLING (WITH CACHING)
// The functions here handle checking whether an export job has finished. The caching
// layer (getExportJobStatusesWithCache) is what lets several concurrently-running
// clients share ONE HTTP request instead of each firing their own every poll cycle.
// =============================================================================

/**
 * Fetches the FULL list of every export job's current status (not just one job) — the
 * API only offers this as a single "list everything" call, so a status check for one
 * specific job always fetches the whole list and then searches it.
 * @param {puppeteer.Page} page - The page to run the fetch from.
 * @param {string} fingerprintValue - The auth cookie value.
 * @returns {Promise<Array<Object>|null>} The full list of job status objects, or null on failure.
 */
async function retrieveAllExportJobStatuses(page, fingerprintValue) {
  try {
    const statusUrl = `${API_BASE_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}`; // Same endpoint used for submitting jobs, used here to list them all
    const evaluationResult = await page.evaluate(
      async (url, fingerprint, timeout) => {
        // Everything inside this function body runs INSIDE the browser, not in Node.
        const abortController = new AbortController(); // Lets us cancel the request if it takes too long
        const timeoutId = setTimeout(() => abortController.abort(), timeout); // Schedule that cancellation

        try {
          const fetchResponse = await fetch(url, {
            method: "GET",
            headers: { Fingerprint: fingerprint }, // The custom auth header the API requires
            signal: abortController.signal, // Wire up the cancellation
          });
          clearTimeout(timeoutId); // The request finished in time — cancel the timeout
          // We return status + text together (instead of just text) so the caller can
          // check the HTTP status BEFORE trying to JSON.parse it — an error page
          // (401/500/HTML) is not valid JSON and would otherwise fail parsing with a
          // confusing message instead of a clear "request failed" message.
          return {
            status: fetchResponse.status,
            data: await fetchResponse.text(),
          };
        } catch (browserFetchError) {
          clearTimeout(timeoutId); // Make sure the timeout never fires after we've already failed some other way
          return {
            status: 0,
            data: `Request failed or timed out: ${browserFetchError.message}`,
          }; // A network error or our own timeout firing
        }
      },
      statusUrl,
      fingerprintValue,
      BROWSER_NAVIGATION_TIMEOUT_MS,
    );

    return parseSuccessfulJsonOrLogFailure(
      evaluationResult,
      statusUrl,
      "STATUS",
    ); // Reuse the same "check status, then parse JSON" logic as the GET helper
  } catch (statusCheckError) {
    console.error(
      `[STATUS] ❌ Error checking export status: ${statusCheckError.message}`,
    ); // Log exactly what went wrong at the Node level
    return null;
  }
}

/**
 * The CALL-REDUCTION core: returns the full export-job-status list, sharing ONE fetch
 * across every caller that asks within EXPORT_POLL_INTERVAL_MS of each other, instead of
 * letting each concurrently-polling client fire its own identical HTTP request.
 *
 * How it decides what to do, in order:
 *  1. If we already have a cached list younger than one poll interval, hand that back
 *     immediately — no network call at all.
 *  2. If the cache is stale but another caller already started a fetch a moment ago
 *     that hasn't finished yet, await that SAME fetch instead of starting a duplicate one.
 *  3. Otherwise, actually issue one new HTTP request (via retrieveAllExportJobStatuses),
 *     always through the single shared, long-lived page — never a short-lived
 *     per-client page that might close mid-fetch.
 * A failed fetch is never cached, so the very next caller will simply try again rather
 * than getting stuck reusing a bad result.
 * @param {string} fingerprintValue - The auth cookie value.
 * @returns {Promise<Array<Object>|null>} The (possibly cached) list of job statuses, or null on failure.
 */
async function getExportJobStatusesWithCache(fingerprintValue) {
  if (isCachedExportStatusListFresh()) {
    return sharedExportStatusCache.list; // Reuse the cached list — no network call needed
  }

  if (sharedExportStatusFetchInFlight) {
    return sharedExportStatusFetchInFlight; // Piggyback on the fetch another caller already started
  }

  if (!sharedExportStatusPage) {
    // Defensive guard: this should never happen during a normal pass, since
    // sharedExportStatusPage is always set right after the browser launches. If it ever
    // does happen, fail loudly rather than silently returning nothing useful.
    console.error(
      "[STATUS] ❌ getExportJobStatusesWithCache called with no active shared page — cannot fetch export statuses.",
    );
    return null;
  }

  sharedExportStatusFetchInFlight =
    fetchAndCacheExportStatusList(fingerprintValue); // Start exactly one new fetch and remember its promise immediately
  return sharedExportStatusFetchInFlight; // The FIRST caller waits on the fetch it just started; later callers (see the in-flight check above) share this same promise
}

/**
 * Checks whether the currently cached export-status list is still within the
 * "fresh enough to reuse" time window.
 * @returns {boolean} True if the cache exists and is younger than one poll interval.
 */
function isCachedExportStatusListFresh() {
  if (sharedExportStatusCache.list === null) {
    return false; // Nothing has ever been successfully cached yet
  }
  const cacheAgeMs = Date.now() - sharedExportStatusCache.fetchedAtMs; // How long ago the cached list was fetched
  return cacheAgeMs < EXPORT_POLL_INTERVAL_MS; // Fresh only if younger than a full poll interval
}

/**
 * Actually performs the shared fetch, updates the cache on success, and always clears
 * the "in-flight" marker once it settles (success OR failure) so the next stale check
 * is free to trigger a brand-new fetch.
 * @param {string} fingerprintValue - The auth cookie value.
 * @returns {Promise<Array<Object>|null>} The freshly fetched list, or null on failure.
 */
async function fetchAndCacheExportStatusList(fingerprintValue) {
  try {
    const freshExportStatusesList = await retrieveAllExportJobStatuses(
      sharedExportStatusPage,
      fingerprintValue,
    ); // The one real HTTP request

    if (Array.isArray(freshExportStatusesList)) {
      // Only cache a genuinely successful result — a failed fetch should never poison
      // the cache with stale-but-"successful-looking" data.
      sharedExportStatusCache.list = freshExportStatusesList; // Store it for reuse by the next callers
      sharedExportStatusCache.fetchedAtMs = Date.now(); // Record exactly when this fetch completed
    }

    return freshExportStatusesList; // Hand the result back to every awaiter of this promise
  } finally {
    sharedExportStatusFetchInFlight = null; // Clear the in-flight marker once this fetch settles, so the NEXT stale check can start a new one
  }
}

/**
 * Repeatedly checks (via the shared cache) whether a specific export job has finished,
 * until it succeeds, fails, or we run out of time.
 * @param {string} exportJobUuid - The UUID of the export job to monitor.
 * @param {string} fingerprintValue - The auth cookie value.
 * @returns {Promise<boolean>} True if the job reached SUCCESS in time, false otherwise.
 */
async function monitorJobUntilCompletion(exportJobUuid, fingerprintValue) {
  const maxAttempts = Math.ceil(
    (MAX_EXPORT_WAIT_MINUTES * 60000) / EXPORT_POLL_INTERVAL_MS,
  ); // How many times we'll check before giving up
  console.log(
    `[STATUS: ${exportJobUuid}] ⏳ Starting poll (max ${MAX_EXPORT_WAIT_MINUTES} min / ${maxAttempts} attempts)`,
  ); // Announce the polling plan

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await pauseExecutionWithLog(EXPORT_POLL_INTERVAL_MS); // Wait one poll interval before checking again

    const exportsList = await getExportJobStatusesWithCache(fingerprintValue); // Get the full job list — possibly a cached/shared result, possibly a fresh fetch
    if (!Array.isArray(exportsList)) {
      continue; // The fetch failed this round — just try again next attempt
    }

    const targetExport = exportsList.find(
      (exportJob) => exportJob.uuid === exportJobUuid,
    ); // Find OUR job within the full list
    if (!targetExport) {
      console.log(
        `[STATUS: ${exportJobUuid}] Attempt ${attempt}/${maxAttempts}. Job status not yet available. Retrying`,
      ); // The job hasn't appeared in the list yet
      continue;
    }

    const outcome = evaluateJobOutcome(
      targetExport,
      exportJobUuid,
      attempt,
      maxAttempts,
    ); // Decide whether this job is done, failed, or still running
    if (outcome !== null) {
      return outcome; // The job reached a final state — hand the result straight back
    }
    // outcome === null means "still running" — the loop continues to the next attempt
  }

  console.warn(
    `[STATUS: ${exportJobUuid}] ⚠️ Did not complete within ${MAX_EXPORT_WAIT_MINUTES} minutes. Timeout reached.`,
  ); // We ran out of attempts without a final answer
  return false;
}

/**
 * Interprets a single job's status entry and logs the result. Returns true/false if the
 * job has reached a final state, or null if it's still in progress (meaning the caller
 * should keep polling).
 * @param {Object} targetExport - This job's entry from the full status list.
 * @param {string} exportJobUuid - Used only for logging.
 * @param {number} attempt - The current attempt number, used only for logging.
 * @param {number} maxAttempts - The total attempts allowed, used only for logging.
 * @returns {boolean|null} true (succeeded), false (failed), or null (still running).
 */
function evaluateJobOutcome(targetExport, exportJobUuid, attempt, maxAttempts) {
  const taskState = targetExport.task?.post_state; // The job's current state string
  const progress = targetExport.task?.progress || 0; // The job's current progress percentage (default 0 if missing)

  if (taskState === "SUCCESS") {
    console.log(`[STATUS: ${exportJobUuid}] ✅ Completed successfully.`); // The job is done and succeeded
    return true;
  }

  if (taskState === "FAILURE") {
    console.error(`[STATUS: ${exportJobUuid}] ❌ Failed. State: FAILURE.`); // The job is done but failed
    return false;
  }

  console.log(
    `[STATUS: ${exportJobUuid}] Attempt ${attempt}/${maxAttempts}. Progress: ${progress}% (${taskState || "PENDING"})`,
  ); // Still running — report current progress
  return null; // Signal "keep polling" to the caller
}

// =============================================================================
// SECTION: DOWNLOAD HANDLING
// Functions for actually downloading a finished export file and moving it into place.
// =============================================================================

/**
 * Triggers the browser to download a finished export file into its configured temp
 * folder, waits for the download to actually finish, then moves the file to its final
 * destination path.
 * @param {puppeteer.Page} page - The page to trigger the download from.
 * @param {string} exportJobUuid - The finished job's UUID, used to build the download URL.
 * @param {string} watchFolderPath - The temp folder the browser is currently configured to save into.
 * @param {string} saveFilePath - The final destination path for the completed file.
 * @returns {Promise<boolean>} True if the download and move both succeeded.
 */
async function downloadExportFileAndRename(
  page,
  exportJobUuid,
  watchFolderPath,
  saveFilePath,
) {
  const finalExportFileName = path.basename(saveFilePath); // Just the filename, for logging
  try {
    const filesBeforeDownload = new Set(
      getDirectoryFilesExcludingTemp(watchFolderPath),
    ); // Snapshot of what's already in the folder BEFORE we trigger the download

    const downloadUrl = `${DOWNLOAD_API_DOMAIN}${EXPORT_REQUESTS_API_ENDPOINT}${exportJobUuid}/download/`; // The URL that actually starts the file download
    console.log(`[DOWNLOAD] 🌐 Visiting ${downloadUrl}`); // Announce the download attempt

    await triggerDownloadNavigation(page, downloadUrl, exportJobUuid); // Navigate to it (handling the expected "download started" quirk)

    console.log(`[DOWNLOAD] Waiting for download to finish...`); // Let the operator know we're now watching the filesystem

    const downloadedFileName = await waitForNewCompletedFile(
      watchFolderPath,
      filesBeforeDownload,
      BROWSER_NAVIGATION_TIMEOUT_MS,
    ); // Wait for a brand-new, fully-downloaded file to appear

    if (!downloadedFileName) {
      throw new Error("Unable to identify completed download file."); // We waited the full timeout and never saw a new finished file
    }

    const downloadedFilePath = path.join(watchFolderPath, downloadedFileName); // Where the browser actually saved the file
    fs.renameSync(downloadedFilePath, saveFilePath); // Move (and rename) it to its real final destination
    console.log(`[DOWNLOAD] ✅ File saved as: ${finalExportFileName}`); // Confirm success
    return true;
  } catch (downloadError) {
    console.error(
      `[DOWNLOAD] ❌ Error downloading job ${exportJobUuid}: ${downloadError.message}`,
    ); // Log exactly what went wrong, including the job ID
    return false;
  }
}

/**
 * Navigates to a URL that triggers a file download. Browsers reject this kind of
 * navigation with a "net::ERR_ABORTED" error even when everything worked correctly —
 * that's expected, NOT a real failure, since the download itself proceeds through
 * Chrome's download manager rather than as a normal page load. This function swallows
 * that specific expected error and rethrows anything else.
 * @param {puppeteer.Page} page - The page to navigate.
 * @param {string} downloadUrl - The URL that starts the download.
 * @param {string} exportJobUuid - Used only for logging.
 * @returns {Promise<void>}
 */
async function triggerDownloadNavigation(page, downloadUrl, exportJobUuid) {
  try {
    await page.goto(downloadUrl, {
      waitUntil: "networkidle2", // Wait for network activity to settle (though this usually gets interrupted by the expected abort below)
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS, // Allow up to 5 minutes for large export downloads
    });
  } catch (navigationError) {
    const isExpectedDownloadAbort = /ERR_ABORTED/i.test(
      navigationError.message || "",
    ); // Is this the normal "the page never actually loaded because it's a download" error?
    if (!isExpectedDownloadAbort) {
      console.error(
        `[DOWNLOAD] ❌ Unexpected navigation error while downloading job ${exportJobUuid}: ${navigationError.message}`,
      ); // Log exactly what unusual error occurred before rethrowing
      throw navigationError; // Something genuinely different went wrong — let the caller handle it as a real failure
    }
    console.log(
      `[DOWNLOAD] Navigation aborted as expected (download started).`,
    ); // Confirm we recognized this as the normal, harmless case
  }
}

/**
 * Polls a folder until a file appears that (a) was NOT there before the download
 * started, and (b) no longer has a temp/in-progress extension (meaning Chrome has
 * finished writing it). Polling for BOTH conditions avoids two separate bugs: reporting
 * success before Chrome even created its .crdownload file, or grabbing a file that was
 * already sitting there for an unrelated reason.
 * @param {string} directoryPath - The folder to watch.
 * @param {Set<string>} filesBeforeSet - Filenames that existed before the download started.
 * @param {number} timeoutMs - How long to keep watching before giving up.
 * @returns {Promise<string|null>} The new file's name, or null if we timed out.
 */
async function waitForNewCompletedFile(
  directoryPath,
  filesBeforeSet,
  timeoutMs = 300000,
) {
  const pollIntervalMs = 1000; // Check once per second
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs); // Total number of checks before giving up

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await pauseExecutionSimple(pollIntervalMs); // Wait one second before checking again

    const currentFiles = tryGetDirectoryFilesExcludingTemp(directoryPath); // Get the folder's current finished-file listing (or null if the read itself failed)
    if (currentFiles === null) {
      continue; // Couldn't read the folder this round — just try again next second
    }

    const newlyDownloadedFile = currentFiles.find(
      (fileName) => !filesBeforeSet.has(fileName),
    ); // Look for any file that wasn't there before we started
    if (newlyDownloadedFile) {
      return newlyDownloadedFile; // Found it — hand the filename straight back
    }
  }

  return null; // We watched the whole timeout window and nothing new (and finished) ever appeared
}

/**
 * Same as getDirectoryFilesExcludingTemp(), but returns null (instead of an empty
 * array) on failure and logs the exact reason — used inside waitForNewCompletedFile()
 * so a transient read error is clearly distinguishable from "folder is genuinely empty".
 * @param {string} directoryPath - The folder to read.
 * @returns {Array<string>|null} The finished-file listing, or null on a read failure.
 */
function tryGetDirectoryFilesExcludingTemp(directoryPath) {
  try {
    return getDirectoryFilesExcludingTemp(directoryPath); // Delegate to the shared helper
  } catch (directoryPollError) {
    console.warn(
      `[DOWNLOAD] Could not poll directory ${directoryPath} for completed downloads: ${directoryPollError.message}`,
    ); // Log exactly what went wrong before the caller retries
    return null;
  }
}

// =============================================================================
// SECTION: TABLE-OF-CONTENTS (TOC) / EXPORT SCOPE UTILITIES
// =============================================================================

/**
 * Walks a (possibly deeply nested) Table of Contents structure and flattens it into one
 * simple list of {uuid, code_slug} objects — this flat list is exactly what the export
 * API expects as the export's "scope".
 * @param {Array<Object>} tocArray - The TOC items to walk (top-level or a nested "children" array).
 * @param {Array<Object>} scope - The list being built up across recursive calls (starts empty).
 * @returns {Array<Object>} The complete flattened list of export scope items.
 */
function collectAllTOCItemsForExport(tocArray, scope = []) {
  if (!Array.isArray(tocArray)) {
    return scope; // Base case: nothing to walk, just hand back whatever we've collected so far
  }

  for (const tocItem of tocArray) {
    if (tocItem.uuid && tocItem.slug) {
      scope.push({ uuid: tocItem.uuid, code_slug: tocItem.slug }); // Add this item to the flat scope list
    }
    if (tocItem.children && Array.isArray(tocItem.children)) {
      collectAllTOCItemsForExport(tocItem.children, scope); // Recurse into this item's children, adding them to the SAME shared scope array
    }
  }

  return scope; // Hand back the fully flattened list
}

// =============================================================================
// SECTION: MISCELLANEOUS HELPERS
// =============================================================================

/**
 * Navigates a fresh page to the API domain, so any later fetch() calls made from that
 * page's JavaScript context have a real origin instead of an empty "about:blank" one.
 * @param {puppeteer.Page} page - The page to navigate.
 * @returns {Promise<void>}
 */
async function initializeClientPageSession(page) {
  await page.goto(API_BASE_DOMAIN, {
    waitUntil: "domcontentloaded", // We only need the page loaded enough to have a real origin — no need to wait for full network idle
    timeout: BROWSER_NAVIGATION_TIMEOUT_MS, // Standard navigation timeout
  });
}

/**
 * Figures out which "state" subfolder a client's export file should live in. Tries
 * several possible sources of that information, in order of how trustworthy they are,
 * falling back to a generic label if none of them work.
 * @param {Object} clientData - The client's metadata object from the region API.
 * @param {string} regionSlug - The region slug, used as a last-resort fallback.
 * @param {string} clientSlug - The client's own slug, used to try to derive a trailing state code.
 * @returns {string} A lowercase state slug safe to use as a folder name.
 */
function resolveClientStateSlug(clientData, regionSlug, clientSlug) {
  const trailingStateCodeMatch =
    typeof clientSlug === "string" ? clientSlug.match(/-([a-z]{2})$/i) : null; // Try to pull a trailing 2-letter state code off the end of the slug (e.g. "...-ak")
  const slugDerivedState = trailingStateCodeMatch
    ? trailingStateCodeMatch[1]
    : null; // The captured 2-letter code, if the match succeeded

  const possibleStateValues = [
    clientData?.state_slug, // Most trustworthy: an explicit state_slug field
    clientData?.state, // Next: an explicit state field
    clientData?.state_abbr, // Next: an explicit state abbreviation field
    clientData?.region_slug, // Next: an explicit region_slug field
    clientData?.region?.slug, // Next: a nested region object's slug
    slugDerivedState, // Next: whatever we derived from the client slug itself
    regionSlug, // Last resort: just use the region slug we were given
  ]; // Every candidate we're willing to try, from most to least trustworthy

  for (const candidateValue of possibleStateValues) {
    if (typeof candidateValue === "string" && candidateValue.trim()) {
      return candidateValue.trim().toLowerCase(); // Use the first candidate that's an actual non-empty string
    }
  }

  return "unknown-state"; // Nothing usable was found — fall back to a clearly-labeled folder
}

/**
 * Pauses execution for a given duration, logging how long the pause will be. Used for
 * waits the operator would want visibility into (e.g. between export status checks).
 * @param {number} milliseconds - How long to pause.
 * @returns {Promise<void>}
 */
async function pauseExecutionWithLog(milliseconds) {
  console.log(`[UTIL] Pausing for ${milliseconds / 1000} seconds`); // Let the operator know we're intentionally waiting
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Pauses execution for a given duration, without any logging. Used for short internal
 * waits where logging every single one would just be noise (e.g. cookie polling).
 * @param {number} milliseconds - How long to pause.
 * @returns {Promise<void>}
 */
async function pauseExecutionSimple(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Generates a random integer from 0 to 99 (inclusive both ends). Currently unused by
 * default (REGION_START_PERCENT is a fixed constant), but kept available as a documented
 * alternative for randomizing where a pass starts in the region list — see the commented
 * line above REGION_START_PERCENT's declaration.
 * @returns {number} A random integer between 0 and 99.
 */
function generateRandomNumber() {
  return Math.floor(Math.random() * 100); // Math.random() gives [0,1); multiply by 100 for [0,100); floor for an integer in [0,99]
}

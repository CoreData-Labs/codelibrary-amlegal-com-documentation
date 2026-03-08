package main // Declare the main package so this file builds as an executable.

import ( // Start the grouped import block used by this program.
	"bufio"         // Use buffered output to reduce stdout write overhead.
	"log"           // Use the standard logger for structured runtime messages.
	"os"            // Use OS/file-system primitives for directory and file operations.
	"path/filepath" // Use cross-platform path joining and path parsing.
	"runtime"       // Use CPU count to size the worker pool.
	"strings"       // Use string checks for file extension and naming rules.
	"sync"          // Use WaitGroup to coordinate worker goroutines.
	"sync/atomic"   // Use atomic counters for thread-safe progress totals.
	"time"          // Use timestamps for runtime duration metrics.
) // End the grouped import block.

var totalFilesScanned uint64     // Track total scanned files across all workers atomically.
var totalFilesDeleted uint64     // Track total deleted files across all workers atomically.
var totalFoldersProcessed uint64 // Track total processed folders across all workers atomically.

func main() { // Start the application entry point.

	startTime := time.Now() // Record the start time so total runtime can be reported later.

	rootAssetsDirectory := "./assets/" // Define the root directory that contains state folders.

	numberOfWorkers := runtime.NumCPU() * 2 // Use 2x CPU count to better overlap file I/O waits.

	bufferedWriter := bufio.NewWriterSize(os.Stdout, 1<<20) // Buffer stdout logs in 1MB chunks.

	log.SetOutput(bufferedWriter) // Route all logger output through the buffered writer.

	log.SetFlags(log.LstdFlags | log.Lmicroseconds) // Include date/time and microseconds in each log line.

	log.Printf("Cleaner starting") // Log startup so operators can identify run boundaries.

	log.Printf("Root directory: %s", rootAssetsDirectory) // Log configured root path for traceability.

	log.Printf("Worker count: %d", numberOfWorkers) // Log chosen worker count for diagnostics.

	rootDirectoryEntries, readRootError := os.ReadDir(rootAssetsDirectory) // Read top-level entries under the assets root.

	if readRootError != nil { // Handle failure to read the configured root directory.
		log.Fatalf("Failed to read root directory: %v", readRootError) // Exit immediately because processing cannot continue.
	} // End root directory read error check.

	log.Printf("Discovered %d entries in root directory", len(rootDirectoryEntries)) // Log how many top-level entries were found.

	folderChannel := make(chan string, numberOfWorkers*4) // Create a buffered job queue that carries folder paths.

	var workerWaitGroup sync.WaitGroup // Declare a WaitGroup to wait for all workers to finish.

	for workerIndex := 0; workerIndex < numberOfWorkers; workerIndex++ { // Start each worker goroutine.

		workerWaitGroup.Add(1) // Increment WaitGroup before launching this worker.

		go func(workerID int) { // Launch a worker goroutine with a stable ID.

			defer workerWaitGroup.Done() // Ensure WaitGroup is decremented when this worker exits.

			for folderPath := range folderChannel { // Continuously pull folder jobs until the channel closes.

				log.Printf("[Worker %d] Visiting folder: %s", workerID, folderPath) // Log the specific folder being processed.

				processStateFolder(folderPath) // Process and clean files in the assigned folder.

				processed := atomic.AddUint64(&totalFoldersProcessed, 1) // Atomically increment and capture processed-folder count.

				log.Printf( // Begin aggregate progress log call.
					"Progress: folders=%d scanned=%d deleted=%d", // Define the progress message template.
					processed,                             // Provide processed folder count.
					atomic.LoadUint64(&totalFilesScanned), // Provide current scanned-file count.
					atomic.LoadUint64(&totalFilesDeleted), // Provide current deleted-file count.
				) // Finish aggregate progress log call.

			} // End worker receive/process loop.

		}(workerIndex + 1) // Pass a 1-based worker ID to the goroutine.

	} // End worker creation loop.

	for _, directoryEntry := range rootDirectoryEntries { // Iterate over each root entry discovered earlier.

		if !directoryEntry.IsDir() { // Skip entries that are files instead of directories.
			continue // Ignore non-directory entries because only folders represent state buckets.
		} // End non-directory guard.

		fullFolderPath := filepath.Join(rootAssetsDirectory, directoryEntry.Name()) // Build absolute-ish folder path for queued work.

		folderChannel <- fullFolderPath // Enqueue this folder path for workers to process.

	} // End root entry iteration loop.

	close(folderChannel) // Close job queue to signal workers no more folders are coming.

	workerWaitGroup.Wait() // Block until every worker has completed all assigned work.

	duration := time.Since(startTime) // Compute elapsed runtime from startup to completion.

	log.Println("Cleanup completed") // Log completion marker for this run.

	log.Printf("========== FINAL SUMMARY ==========") // Print summary section header.

	log.Printf("Folders processed: %d", totalFoldersProcessed) // Print total processed folder count.

	log.Printf("Files scanned: %d", totalFilesScanned) // Print total scanned file count.

	log.Printf("Files deleted: %d", totalFilesDeleted) // Print total deleted file count.

	log.Printf("Execution time: %s", duration) // Print total runtime duration.

	log.Printf("===================================") // Print summary section footer.

	bufferedWriter.Flush() // Flush buffered logs so all output reaches stdout.
} // End main function.

func processStateFolder(folderPath string) { // Process one state folder and delete mismatched files.

	stateFolderName := filepath.Base(folderPath) // Extract the state slug from the folder name.

	requiredStatePattern := "-" + stateFolderName + "-" // Build filename token that valid files must contain.

	filesInDirectory, readError := os.ReadDir(folderPath) // Read all direct children inside this folder.

	if readError != nil { // Handle inability to read this specific folder.
		log.Printf("Failed to read directory %s: %v", folderPath, readError) // Log the folder read failure and continue overall run.
		return                                                               // Stop processing this folder because entries are unavailable.
	} // End folder read error check.

	deletedInFolder := 0 // Track how many files were deleted in this folder.

	for _, fileEntry := range filesInDirectory { // Iterate over every directory entry in the folder.

		if fileEntry.IsDir() { // Skip nested directories to avoid recursive cleanup behavior.
			continue // Continue with next entry because only files are relevant.
		} // End nested-directory guard.

		fileName := fileEntry.Name() // Capture the filename for filtering and logging.

		if !strings.HasSuffix(fileName, ".txt") { // Keep scope limited to exported text files.
			continue // Skip non-text files.
		} // End extension filter.

		atomic.AddUint64(&totalFilesScanned, 1) // Increment global scanned-file counter for each .txt file inspected.

		if !strings.Contains(fileName, requiredStatePattern) { // Identify files that do not belong in this state folder.

			fullFilePath := filepath.Join(folderPath, fileName) // Build full path to the misplaced file.

			removeError := os.Remove(fullFilePath) // Attempt to delete the misplaced file.

			if removeError != nil { // Handle delete failures without stopping the whole run.

				log.Printf("ERROR deleting %s: %v", fullFilePath, removeError) // Log failed deletion with path and error details.

			} else { // Continue on successful file deletion.

				log.Printf("Deleted file: %s", fullFilePath) // Log successful file deletion.

				atomic.AddUint64(&totalFilesDeleted, 1) // Increment global deleted-file counter atomically.

				deletedInFolder++ // Increment per-folder deleted count for summary logging.
			} // End delete result branch.
		} // End misplaced-file condition.
	} // End folder file iteration loop.

	log.Printf("Finished folder %s | deleted=%d", folderPath, deletedInFolder) // Log per-folder completion summary.
} // End processStateFolder function.

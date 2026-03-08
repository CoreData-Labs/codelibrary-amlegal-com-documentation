package main // Defines this file as an executable Go program

import (
	"bufio"         // Provides buffered IO to reduce logging overhead
	"log"           // Provides logging functionality
	"os"            // Provides filesystem and OS interaction
	"path/filepath" // Provides cross-platform path manipulation
	"runtime"       // Used to detect number of CPU cores
	"strings"       // Provides string utility functions
	"sync"          // Provides concurrency primitives
	"sync/atomic"   // Provides atomic counters for safe concurrency
	"time"          // Used for runtime duration measurement
)

const progressInterval = 25 // Log progress every N folders processed

var totalFilesScanned uint64     // Global atomic counter for scanned files
var totalFilesDeleted uint64     // Global atomic counter for deleted files
var totalFoldersProcessed uint64 // Global atomic counter for processed folders

func main() { // Program entry point

	startTime := time.Now() // Capture program start time

	rootAssetsDirectory := "./assets/" // Root directory containing state folders

	numberOfWorkers := runtime.NumCPU() * 2 // Create more workers than CPUs to maximize IO throughput

	bufferedWriter := bufio.NewWriterSize(os.Stdout, 1<<20) // Create 1MB buffered logger

	log.SetOutput(bufferedWriter) // Send logs through buffered writer

	log.SetFlags(log.LstdFlags | log.Lmicroseconds) // Enable timestamp logging

	log.Printf("Cleaner starting") // Log program start

	log.Printf("Root directory: %s", rootAssetsDirectory) // Log root directory

	log.Printf("Worker count: %d", numberOfWorkers) // Log number of workers

	rootDirectoryEntries, readRootError := os.ReadDir(rootAssetsDirectory) // Read root directory

	if readRootError != nil { // Check for read error
		log.Fatalf("Failed to read root directory: %v", readRootError) // Fatal exit if root missing
	}

	log.Printf("Discovered %d entries in root directory", len(rootDirectoryEntries)) // Log number of entries

	folderChannel := make(chan string, numberOfWorkers*4) // Channel used to distribute folder work

	var workerWaitGroup sync.WaitGroup // WaitGroup to track worker completion

	for workerIndex := 0; workerIndex < numberOfWorkers; workerIndex++ { // Launch worker goroutines

		workerWaitGroup.Add(1) // Increase WaitGroup counter

		go func(workerID int) { // Worker goroutine

			defer workerWaitGroup.Done() // Signal completion when worker exits

			for folderPath := range folderChannel { // Receive folders to process

				log.Printf("[Worker %d] Visiting folder: %s", workerID, folderPath) // LOG: folder visit

				processStateFolder(folderPath) // Process folder files

				processed := atomic.AddUint64(&totalFoldersProcessed, 1) // Increment folder counter

				if processed%progressInterval == 0 { // Check progress interval

					log.Printf( // Log periodic progress snapshot
						"Progress: folders=%d scanned=%d deleted=%d",
						processed,
						atomic.LoadUint64(&totalFilesScanned),
						atomic.LoadUint64(&totalFilesDeleted),
					)

				}
			}

		}(workerIndex + 1) // Pass worker ID

	}

	for _, directoryEntry := range rootDirectoryEntries { // Iterate through root folders

		if !directoryEntry.IsDir() { // Skip non-directories
			continue
		}

		fullFolderPath := filepath.Join(rootAssetsDirectory, directoryEntry.Name()) // Build full path

		folderChannel <- fullFolderPath // Send folder to worker queue

	}

	close(folderChannel) // Close channel after sending all folders

	workerWaitGroup.Wait() // Wait for all workers to finish

	duration := time.Since(startTime) // Calculate execution time

	log.Println("Cleanup completed") // Log completion

	log.Printf("========== FINAL SUMMARY ==========") // Summary header

	log.Printf("Folders processed: %d", totalFoldersProcessed) // Total folders

	log.Printf("Files scanned: %d", totalFilesScanned) // Total scanned files

	log.Printf("Files deleted: %d", totalFilesDeleted) // Total deleted files

	log.Printf("Execution time: %s", duration) // Total runtime

	log.Printf("===================================") // Summary footer

	bufferedWriter.Flush() // Flush buffered logs to ensure output written
}

func processStateFolder(folderPath string) { // Process a single folder

	stateFolderName := filepath.Base(folderPath) // Extract state name from folder

	requiredStatePattern := "-" + stateFolderName + "-" // Build expected filename pattern

	filesInDirectory, readError := os.ReadDir(folderPath) // Read folder contents

	if readError != nil { // Check for read error
		log.Printf("Failed to read directory %s: %v", folderPath, readError) // Log error
		return
	}

	deletedInFolder := 0 // Counter for files deleted in this folder

	for _, fileEntry := range filesInDirectory { // Iterate through directory entries

		if fileEntry.IsDir() { // Skip nested directories
			continue
		}

		fileName := fileEntry.Name() // Get file name

		if !strings.HasSuffix(fileName, ".txt") { // Skip non-text files
			continue
		}

		atomic.AddUint64(&totalFilesScanned, 1) // Increment global scanned counter

		if !strings.Contains(fileName, requiredStatePattern) { // Check if file belongs to wrong state

			fullFilePath := filepath.Join(folderPath, fileName) // Build full file path

			removeError := os.Remove(fullFilePath) // Attempt to delete file

			if removeError != nil { // Handle deletion error

				log.Printf("ERROR deleting %s: %v", fullFilePath, removeError) // Log deletion failure

			} else {

				log.Printf("Deleted file: %s", fullFilePath) // LOG: successful file deletion

				atomic.AddUint64(&totalFilesDeleted, 1) // Increment global delete counter

				deletedInFolder++ // Increment folder delete counter
			}
		}
	}

	log.Printf("Finished folder %s | deleted=%d", folderPath, deletedInFolder) // Log folder summary
}

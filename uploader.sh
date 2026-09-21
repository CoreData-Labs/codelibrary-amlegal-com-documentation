#!/usr/bin/bash
# Run this script with the Bash interpreter located at /usr/bin/bash

# =============================================================================
# Auto Git Sync
# -----------------------------------------------------------------------------
# Watches a Git repository and automatically commits and pushes changes when:
#   1. Many files have changed (early push), OR
#   2. Enough time has passed since the last successful push (scheduled push).
# =============================================================================

set -u -o pipefail
# -u          : treat use of an undefined variable as an error (catches typos)
# -o pipefail : a pipeline fails if ANY command in it fails, not just the last

# -----------------------------------------------------------------------------
# Configuration (each value can be overridden with an environment variable)
# -----------------------------------------------------------------------------

readonly CHECK_INTERVAL_SECONDS="${CHECK_INTERVAL_SECONDS:-60}"
# How long to sleep between repository checks (default: 60 seconds)

readonly MAX_SECONDS_BETWEEN_PUSHES="${MAX_SECONDS_BETWEEN_PUSHES:-43200}"
# Push at least this often, even if few files changed (default: 12 hours)

readonly CHANGED_FILES_PUSH_THRESHOLD="${CHANGED_FILES_PUSH_THRESHOLD:-100}"
# Push early once this many files have changed (default: 100 files)

# -----------------------------------------------------------------------------
# Logging helpers
# -----------------------------------------------------------------------------

function log_info() {
	# Print an informational message with a timestamp
	echo "[INFO]    $(date '+%Y-%m-%d %H:%M:%S') - $*"
	# "$*" joins every argument passed to this function into one message
}

function log_success() {
	# Print a success message with a timestamp
	echo "[SUCCESS] $(date '+%Y-%m-%d %H:%M:%S') - $*"
	# Same format as log_info, but labelled SUCCESS
}

function log_error() {
	# Print an error message with a timestamp
	echo "[ERROR]   $(date '+%Y-%m-%d %H:%M:%S') - $*" >&2
	# ">&2" sends the message to stderr so errors can be separated from normal output
}

# -----------------------------------------------------------------------------
# Repository inspection helpers
# -----------------------------------------------------------------------------

function is_inside_git_repository() {
	# Succeeds (exit code 0) only when the current folder is inside a Git repository
	git rev-parse --is-inside-work-tree >/dev/null 2>&1
	# Ask Git; discard its output because only the exit code matters
}

function count_changed_files() {
	# Print how many files are modified, added, deleted, or untracked
	git status --porcelain --untracked-files=all | wc -l | tr -d ' '
	# --porcelain            : stable, script-friendly output (one line per file)
	# --untracked-files=all  : list every new file individually, not just new folders
	# wc -l                  : count the lines (one line = one changed file)
	# tr -d ' '              : strip the padding spaces some systems add (e.g. macOS)
}

function count_unpushed_commits() {
	# Print how many local commits have not been pushed to the remote yet
	local unpushed_commits_count
	# Declare a local variable to hold the result

	if unpushed_commits_count="$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null)"; then
		# '@{upstream}..HEAD' means "commits on my branch that the remote lacks"
		# Enter this block if Git answered successfully
		echo "${unpushed_commits_count}"
		# Print the real count
	else
		# Git failed, usually because no upstream branch is set
		echo 0
		# Report 0 so the rest of the script keeps working
	fi
	# End of the upstream check
}

function get_current_epoch_seconds() {
	# Print the current time as seconds since 1970-01-01 (the Unix epoch)
	date +%s
}

# -----------------------------------------------------------------------------
# Decision logic
# -----------------------------------------------------------------------------

function is_sync_trigger_reached() {
	# Succeeds when either push condition is met
	# Arguments: $1 = changed file count, $2 = seconds since last push
	local changed_files_count="$1"
	# Save the first argument under a readable name

	local seconds_since_last_push="$2"
	# Save the second argument under a readable name

	if [[ "${changed_files_count}" -ge "${CHANGED_FILES_PUSH_THRESHOLD}" ]]; then
		# Check whether too many files have changed
		return 0
		# Too many files changed -> trigger reached
	fi
	# End of the changed-files check

	if [[ "${seconds_since_last_push}" -ge "${MAX_SECONDS_BETWEEN_PUSHES}" ]]; then
		# Check whether too much time has passed since the last push
		return 0
		# Too much time has passed -> trigger reached
	fi
	# End of the elapsed-time check

	return 1
	# Neither condition was met -> no trigger yet
}

# -----------------------------------------------------------------------------
# Git action helpers (each one returns 0 on success, non-zero on failure)
# -----------------------------------------------------------------------------

function stage_and_commit_all_changes() {
	# Stage every change (add, modify, delete) and record it as one commit
	local commit_timestamp
	# Declare a local variable so it does not leak outside this function

	commit_timestamp="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
	# Build a UTC timestamp so commit messages are consistent across timezones

	log_info "Staging all changes (additions, modifications, deletions)..."
	# Tell the user which step is running

	if ! git add --all; then
		# Try to stage everything; enter this block if staging fails
		log_error "Failed to stage changes. Check file permissions and repository state."
		# Explain the likely cause
		return 1
		# Report failure to the caller
	fi
	# End of the staging check

	log_info "Creating commit..."
	# Tell the user the commit step is starting

	if git commit --quiet --message "Auto-sync commit (${commit_timestamp})"; then
		# Try to commit; enter this block if it succeeds
		log_success "Commit created."
		# Confirm the commit was made
		return 0
		# Report success to the caller
	fi
	# End of the commit check

	log_error "Commit failed (possibly nothing to commit, or a commit hook rejected it)."
	# Explain the failure
	return 1
	# Report failure to the caller
}

function pull_latest_changes_with_rebase() {
	# Fetch remote changes and replay our local commits on top of them
	log_info "Pulling latest changes from the remote repository..."
	# Tell the user which step is running

	if git pull --rebase --quiet; then
		# --rebase keeps history linear (no extra merge commits)
		# Enter this block if the pull succeeded
		return 0
		# Report success to the caller
	fi
	# End of the pull check

	log_error "Pull/rebase failed. Possible causes: merge conflict, network issue, or bad credentials."
	# Explain the likely causes

	if [[ -d "$(git rev-parse --git-path rebase-merge)" || -d "$(git rev-parse --git-path rebase-apply)" ]]; then
		# Detect a half-finished rebase, which would block every future pull
		log_info "Aborting the unfinished rebase so the repository returns to a clean state."
		# Tell the user what we are about to do
		git rebase --abort >/dev/null 2>&1
		# Undo the partial rebase; your commits stay safe locally
	fi
	# End of the unfinished-rebase check

	return 1
	# Report failure to the caller
}

function push_commits_to_remote() {
	# Upload local commits to the remote repository
	log_info "Pushing changes to the remote repository..."
	# Tell the user which step is running

	if git push --quiet; then
		# Try to push; enter this block if it succeeds
		log_success "Push completed."
		# Confirm the push worked
		return 0
		# Report success to the caller
	fi
	# End of the push check

	log_error "Push failed. Possible causes: bad credentials, protected branch, or network issue."
	# Explain the likely causes
	return 1
	# Report failure to the caller
}

# -----------------------------------------------------------------------------
# One full sync cycle: commit (if needed) -> pull -> push
# -----------------------------------------------------------------------------

function sync_changes_to_remote() {
	# Run all sync steps in order; stop at the first failure
	# Arguments: $1 = changed file count
	local changed_files_count="$1"
	# Save the argument under a readable name

	if [[ "${changed_files_count}" -gt 0 ]]; then
		# Only commit when there is something new to commit
		if ! stage_and_commit_all_changes; then
			# Try to stage and commit; enter this block if that fails
			return 1
			# Stop this cycle because the commit step failed
		fi
		# End of the staging/commit check
	fi
	# End of the commit step

	if ! pull_latest_changes_with_rebase; then
		# Commit first, then rebase: the working tree is clean so no stash is needed
		# Enter this block if the pull/rebase fails
		return 1
		# Stop this cycle because the pull failed
	fi
	# End of the pull check

	if ! push_commits_to_remote; then
		# Upload everything; enter this block if the push fails
		return 1
		# Stop this cycle because the push failed
	fi
	# End of the push check

	return 0
	# Every step worked
}

# -----------------------------------------------------------------------------
# Status report
# -----------------------------------------------------------------------------

function print_status_report() {
	# Show a short summary of the current repository state
	# Arguments: $1 = changed file count, $2 = seconds since last push
	echo "------------------------------------------------------------"
	# Visual separator (top)
	echo "Repository Status Report"
	# Report title
	echo "Time                 : $(date)"
	# Current human-readable time
	echo "Changed files        : $1"
	# How many files differ from the last commit
	echo "Seconds since push   : $2"
	# How long ago the last successful push happened
	echo "------------------------------------------------------------"
	# Visual separator (bottom)
}

# -----------------------------------------------------------------------------
# Main monitoring loop
# -----------------------------------------------------------------------------

function run_monitoring_loop() {
	# Repeat forever: check the repository, sync when a trigger is reached, then sleep
	local last_successful_push_epoch
	# Time (in epoch seconds) of the last successful push

	last_successful_push_epoch="$(get_current_epoch_seconds)"
	# Start the clock now, so the first scheduled push happens one full period from launch

	while true; do
		# Loop until the user stops the script (Ctrl+C)

		local current_epoch seconds_since_last_push changed_files_count unpushed_commits_count
		# Declare this iteration's working variables

		current_epoch="$(get_current_epoch_seconds)"
		# Read the current time

		seconds_since_last_push=$((current_epoch - last_successful_push_epoch))
		# Work out how long it has been since the last push

		changed_files_count="$(count_changed_files)"
		# Count files that changed since the last commit

		unpushed_commits_count="$(count_unpushed_commits)"
		# Count commits waiting to be pushed (e.g. left over after a failed push)

		print_status_report "${changed_files_count}" "${seconds_since_last_push}"
		# Show the user the current state

		if is_sync_trigger_reached "${changed_files_count}" "${seconds_since_last_push}"; then
			# A push condition was met; decide what to do next

			if [[ "${changed_files_count}" -eq 0 && "${unpushed_commits_count}" -eq 0 ]]; then
				# Nothing to commit and nothing waiting to be pushed
				log_info "Trigger reached but there is nothing to sync. Resetting the timer."
				# Explain why we are skipping the sync
				last_successful_push_epoch="$(get_current_epoch_seconds)"
				# Restart the clock so this message does not repeat every check
			elif sync_changes_to_remote "${changed_files_count}"; then
				# There was work to do and the whole sync worked
				last_successful_push_epoch="$(get_current_epoch_seconds)"
				# Restart the clock from the moment of the successful push
			else
				# Something failed; keep the old timer so we retry on the next check
				log_error "Sync failed. Will retry in ${CHECK_INTERVAL_SECONDS} seconds."
				# Tell the user a retry is coming
			fi
			# End of the sync decision
		fi
		# End of the trigger check

		sleep "${CHECK_INTERVAL_SECONDS}"
		# Wait before checking again (avoids constant CPU usage)
	done
	# End of the infinite loop
}

# -----------------------------------------------------------------------------
# Entry point
# -----------------------------------------------------------------------------

function main() {
	# Validate the environment, then start monitoring
	trap 'echo; log_info "Stopped by user. Goodbye!"; exit 0' INT TERM
	# On Ctrl+C or a termination signal, print a friendly message and exit cleanly

	if ! is_inside_git_repository; then
		# Refuse to run outside a Git repository
		log_error "This folder is not a Git repository. Run the script from inside one."
		# Explain the problem
		exit 1
		# Exit with an error code
	fi
	# End of the repository check

	log_info "Auto Git Sync started."
	# Announce startup

	log_info "Checking every ${CHECK_INTERVAL_SECONDS}s | early push at ${CHANGED_FILES_PUSH_THRESHOLD} files | forced push every ${MAX_SECONDS_BETWEEN_PUSHES}s"
	# Show the active settings so the user can confirm them

	run_monitoring_loop
	# Begin the never-ending monitoring loop
}

main "$@"
# Start the script and forward any command-line arguments to main

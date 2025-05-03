// SPDX-License-Identifier: MIT
// rename-assets.ts - https://github.com/YektaDev/rename-assets
/*--------------------------------------------------------------------------------------------------
 * DISCLAIMER: This script ONLY works if you know you don't use any of the built resource names for
 *             any purpose other than referencing those exact files, which is the case for most
 *             projects, since the resource file names are in the format of: [name].[hash].[ext]
 * -------------------------------------------------------------------------------------------------
 *              NO GUARANTEES ARE MADE THAT THIS SCRIPT WILL WORK FOR YOUR PROJECT.
 * -------------------------------------------------------------------------------------------------
 * To set up (PNPM):
 *   - Copy the file to: scripts/rename-assets.ts and edit the Configuration.
 *   - Run: pnpm i -D @types/node ts-node xxhash-wasm istextorbinary
 * To execute: pnpm ts-node scripts/rename-assets.ts
 *------------------------------------------------------------------------------------------------*/

import { readdir, readFile, rename, stat, writeFile } from "fs/promises";
import * as path from "path";
import xxhashWasmFactory, { type XXHash } from "xxhash-wasm";
// @ts-ignore
import { isBinary } from "istextorbinary";

// --- Configuration ---
const DIST_DIR = "dist";
const ASSETS_SUBDIR = "x"; // The subdirectory within DIST_DIR containing assets to rename
const RENAME_EXT_WHITELIST = [".js", ".css", ".woff2", ".woff"];
// --- End Configuration ---

const distPath = path.resolve(process.cwd(), DIST_DIR);
const assetsPath = path.join(distPath, ASSETS_SUBDIR);

// Type for the filename mapping
type FileNameMapping = Map<string, string>; // Map<oldBasename, newBasename>

/**
 * Calculates the 64-bit xxHash of a buffer and returns it as a hex string.
 * @param hasher - Initialized XXHash64 instance.
 * @param buffer - The file content buffer.
 * @returns The hex representation of the xxHash64.
 */
const calculateXxhash64Hex = (hasher: XXHash<bigint>, buffer: Buffer): string =>
  hasher.update(buffer).digest().toString(16).padStart(16, "0");

/**
 * Recursively finds all file paths within a given directory.
 * @param dirPath - The absolute path to the directory to scan.
 * @param allFiles - An array to accumulate the file paths.
 * @returns A promise that resolves when the scan is complete.
 */
async function findFilesRecursively(dirPath: string, allFiles: string[] = []): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await findFilesRecursively(fullPath, allFiles);
      } else if (entry.isFile()) {
        allFiles.push(fullPath);
      }
    }
  } catch (error: any) {
    // Log error but continue if possible (e.g., permission denied for a subdir)
    console.error(`Error reading directory ${dirPath}: ${error.message}`);
  }
  return allFiles;
}

let iteration = 1;

/**
 * Main script logic.
 */
async function run(): Promise<void> {
  // console.log("Starting asset renaming process...");

  console.log(`Iteration #${iteration}`);
  const { create64 } = await xxhashWasmFactory();

  const filenameMapping: FileNameMapping = new Map();

  // --- Phase 1: Rename Assets in assetsPath ---
  // console.log(`Phase 1: Renaming assets in ${assetsPath}`);
  try {
    const assetFiles = await readdir(assetsPath);

    for (const oldFilename of assetFiles) {
      if (!RENAME_EXT_WHITELIST.includes(path.extname(oldFilename))) continue;
      const oldFilePath = path.join(assetsPath, oldFilename);
      const fileStats = await stat(oldFilePath);

      // Ensure it's a file before processing
      if (!fileStats.isFile()) {
        console.log(`Skipping non-file entry: ${oldFilename}`);
        continue;
      }

      let fileBuffer: Buffer;
      try {
        fileBuffer = await readFile(oldFilePath);
      } catch (readError: any) {
        console.error(`Error reading file ${oldFilePath}: ${readError.message}`);
        // Decide whether to skip or throw. Skipping allows partial success.
        console.warn(`Skipping rename for ${oldFilename} due to read error.`);
        continue;
      }

      const hasher64 = create64();
      const hashHex = calculateXxhash64Hex(hasher64, fileBuffer);
      const extension = path.extname(oldFilename); // Includes the dot (e.g., '.png')
      const newFilename = `${hashHex}${extension}`;
      const newFilePath = path.join(assetsPath, newFilename);

      if (oldFilePath === newFilePath) {
        //console.log(`Skipping rename for ${oldFilename} (already named correctly).`);
        continue; // Skip if name wouldn't change
      }

      try {
        await rename(oldFilePath, newFilePath);
        filenameMapping.set(oldFilename, newFilename); // Map old basename -> new basename
        console.log(`Renamed: ${oldFilename} -> ${newFilename}`);
      } catch (renameError: any) {
        console.error(`Error renaming ${oldFilename} to ${newFilename}: ${renameError.message}`);
        // Decide whether to skip or throw. Skipping allows partial success.
        console.warn(`Skipping reference updates for ${oldFilename} due to rename error.`);
        // If rename fails, we MUST NOT add it to the mapping
      }
    }
  } catch (error: any) {
    if (error.code === "ENOENT") {
      console.error(`Error: Assets directory not found at ${assetsPath}. Did the build run correctly?`);
    } else {
      console.error(`Error reading assets directory ${assetsPath}: ${error.message}`);
    }
    throw new Error("Failed during asset renaming phase."); // Stop the process if we can't read the assets dir
  }

  // console.log(`Phase 1 completed. ${filenameMapping.size} assets renamed.`);

  if (filenameMapping.size === 0) {
    console.log("No assets were renamed. Skipping reference update phase.");
    return;
  }

  // --- Phase 2: Update References in distPath ---
  let updatedFileCount = 0;
  try {
    const allFiles = await findFilesRecursively(distPath);
    console.log(`Found ${allFiles.length} total files to scan for references.`);

    for (const filePath of allFiles) {
      // Optimization: Skip the mapping file itself if we were to create one
      // if (path.basename(filePath) === 'asset-map.json') continue;

      let fileBuffer: Buffer;
      try {
        fileBuffer = await readFile(filePath);
      } catch (readError: any) {
        console.error(`Error reading file ${filePath} for reference update: ${readError.message}`);
        console.warn(`Skipping reference update for ${filePath}.`);
        continue;
      }

      // Check if the file is binary - skip if it is
      // Pass null as the second arg because we already have the buffer
      if (isBinary(null, fileBuffer)) {
        // console.log(`Skipping binary file: ${filePath}`);
        continue;
      }

      let content: string;
      try {
        // Assume UTF-8 for text files in build output
        content = fileBuffer.toString("utf8");
      } catch (decodeError: any) {
        console.error(`Error decoding file ${filePath} as UTF-8: ${decodeError.message}`);
        console.warn(`Skipping reference update for ${filePath}.`);
        continue;
      }

      let originalContent = content;

      // Iterate through the mapping and replace occurrences
      for (const [oldName, newName] of filenameMapping.entries()) {
        // Use replaceAll for global replacement.
        // The assumption is that `oldName` (e.g., file.hash.ext) is unique enough to avoid accidental replacements.
        // Consider adding boundary checks (e.g., using regex `\b` or specific quoting/path separators)
        // if collisions become a problem, but stick to simple replaceAll for now.
        if (content.includes(oldName)) {
          content = content.replaceAll(oldName, newName);
        }
      }

      // Write back only if changes were made
      if (content !== originalContent) {
        try {
          await writeFile(filePath, content, "utf8");
          console.log(`Updated references in: ${path.relative(distPath, filePath)}`);
          updatedFileCount++;
        } catch (writeError: any) {
          console.error(`Error writing updated file ${filePath}: ${writeError.message}`);
          // Log error but continue processing other files
        }
      }
    }
  } catch (error: any) {
    console.error(`Error during reference update phase: ${error.message}`);
    throw new Error("Failed during reference update phase.");
  }

  if (updatedFileCount === 0) {
    console.log(`Asset renaming and reference update process finished successfully in ${iteration} iterations.`);
  } else {
    // The script works without any iterations.
    // This is just an obsessive behavior over having the "final" state.
    // Feel free to drop iterations.
    if (iteration++ > 9) {
      throw new Error("Too many iterations. There is most likely a cyclic reference.");
    }
    return await run();
  }
}

// --- Script Execution ---
run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("-------------------------");
    console.error("Script failed unexpectedly:");
    console.error(error);
    console.error("-------------------------");
    process.exitCode = 1;
  });

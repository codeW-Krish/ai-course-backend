// ============================================================
//  Video Render Service
//  Combines SVG/image assets + TTS audio → MP4 video
//  Uses FFmpeg for rendering + Puppeteer for SVG→PNG
// ============================================================

import { spawn } from "child_process";
import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { CANVAS_W, CANVAS_H } from "./svgGeneratorService.js";

// ─────────────────────────────────────────
//  Config
// ─────────────────────────────────────────

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";
const OUTPUT_DIR = process.env.VIDEO_OUTPUT_DIR || path.join(os.tmpdir(), "ailearner_videos");

const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const FPS = 30;
const VIDEO_BITRATE = "4M";
const AUDIO_BITRATE = "128k";

// Ensure output dir exists
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ─────────────────────────────────────────
//  Helper: run ffmpeg command
// ─────────────────────────────────────────

function runFFmpeg(args, label = "ffmpeg") {
  return new Promise((resolve, reject) => {
    console.log(`🎬 [${label}] Running: ${FFMPEG_BIN} ${args.join(" ")}`);
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.stdout.on("data", () => {}); // consume stdout

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`❌ [${label}] Exited with code ${code}: ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg (${label}) failed with code ${code}`));
      } else {
        resolve();
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`FFmpeg not found or failed to start: ${err.message}. Install FFmpeg or set FFMPEG_PATH env var.`));
    });
  });
}

// ─────────────────────────────────────────
//  Helper: get audio duration via ffprobe
// ─────────────────────────────────────────

export function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE_BIN, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      audioPath,
    ]);

    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("ffprobe failed"));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        resolve(parseFloat(info.format.duration));
      } catch {
        reject(new Error("Could not parse audio duration"));
      }
    });
    proc.on("error", (err) => {
      reject(new Error(`ffprobe not found: ${err.message}`));
    });
  });
}

// ─────────────────────────────────────────
//  SVG → PNG conversion
//  Uses resvg-js (fast, no browser needed)
// ─────────────────────────────────────────

let resvgModule = null;

async function svgToPng(svgString, outputPath) {
  // Lazy-load resvg-js
  if (!resvgModule) {
    try {
      resvgModule = await import("@aspect-run/resvg");
    } catch {
      try {
        resvgModule = await import("@aspect-run/resvg");
      } catch {
        // Fallback: write SVG as-is and convert via ffmpeg
        console.warn("⚠️ resvg not available, falling back to FFmpeg for SVG→PNG");
        return svgToPngViaFFmpeg(svgString, outputPath);
      }
    }
  }

  try {
    // Try using Resvg class
    if (resvgModule.Resvg) {
      const resvg = new resvgModule.Resvg(svgString, {
        fitTo: { mode: "width", value: VIDEO_WIDTH },
      });
      const pngData = resvg.render();
      await fs.writeFile(outputPath, pngData.asPng());
      return outputPath;
    }
  } catch {
    // Fall through to alternative
  }

  // Alternative: sharp-based conversion
  return svgToPngViaSharp(svgString, outputPath);
}

async function svgToPngViaSharp(svgString, outputPath) {
  try {
    const sharp = (await import("sharp")).default;
    const pngBuffer = await sharp(Buffer.from(svgString))
      .resize(VIDEO_WIDTH, VIDEO_HEIGHT)
      .png()
      .toBuffer();
    await fs.writeFile(outputPath, pngBuffer);
    return outputPath;
  } catch (err) {
    console.warn(`⚠️ sharp not available: ${err.message}, writing SVG directly`);
    // Write SVG and use it directly with ffmpeg -i
    const svgPath = outputPath.replace(".png", ".svg");
    await fs.writeFile(svgPath, svgString);
    return svgPath;
  }
}

async function svgToPngViaFFmpeg(svgString, outputPath) {
  const svgPath = outputPath.replace(".png", ".svg");
  await fs.writeFile(svgPath, svgString);

  try {
    await runFFmpeg([
      "-i", svgPath,
      "-vf", `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}`,
      "-y", outputPath,
    ], "svg-to-png");
    await fs.unlink(svgPath).catch(() => {});
    return outputPath;
  } catch {
    return svgPath; // Return SVG path as fallback
  }
}

// ─────────────────────────────────────────
//  Download image from URL to local file
// ─────────────────────────────────────────

async function downloadImage(url, outputPath) {
  const { default: axios } = await import("axios");
  const response = await axios.get(url, { responseType: "arraybuffer" });
  await fs.writeFile(outputPath, response.data);
  return outputPath;
}

// ─────────────────────────────────────────
//  Render a single scene to video clip
//  Input: visual asset (SVG/image) + audio
//  Output: MP4 clip
// ─────────────────────────────────────────

/**
 * Render a single scene to an MP4 clip.
 *
 * @param {Object} params
 * @param {string} params.visualPath - Path to PNG/SVG/image file
 * @param {string} params.audioPath  - Path to WAV/MP3 audio file
 * @param {number} params.duration   - Duration in seconds
 * @param {string} params.animationStyle - Animation type
 * @param {string} params.outputPath - Output MP4 path
 * @param {string} params.textOverlay  - Optional text overlay
 * @returns {Promise<string>} output path
 */
export async function renderSceneClip({
  visualPath,
  audioPath,
  duration,
  animationStyle = "zoom",
  outputPath,
  textOverlay = "",
}) {
  const args = [];

  // Input: loop image for duration
  args.push("-loop", "1");
  args.push("-t", String(duration));
  args.push("-i", visualPath);

  // Input: audio
  if (audioPath) {
    args.push("-i", audioPath);
  }

  // Video filter chain
  const filters = [];

  // Scale to target resolution
  filters.push(`scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease`);
  filters.push(`pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x0a0a0f`);

  // Animation based on style
  switch (animationStyle) {
    case "zoom":
      // Ken Burns slow zoom in
      filters.push(
        `zoompan=z='min(zoom+0.0008,1.15)':d=${duration * FPS}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${FPS}`
      );
      break;

    case "parallax":
      // Slight horizontal pan
      filters.push(
        `zoompan=z='1.08':x='if(gte(on,1),x+0.5,0)':d=${duration * FPS}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${FPS}`
      );
      break;

    case "slide":
      // Slide from right
      filters.push(
        `zoompan=z='1.02':x='if(gte(on,1),max(x-1,0),(iw-ow)/2)':d=${duration * FPS}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${FPS}`
      );
      break;

    case "scale_pulse":
      // Subtle scale pulse
      filters.push(
        `zoompan=z='1+0.02*sin(on*0.05)':d=${duration * FPS}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${FPS}`
      );
      break;

    default:
      // Static with format conversion
      filters.push(`fps=${FPS}`);
      break;
  }

  // Text overlay if provided
  if (textOverlay) {
    const escapedText = textOverlay.replace(/'/g, "\\'").replace(/:/g, "\\:");
    filters.push(
      `drawtext=text='${escapedText}':fontsize=42:fontcolor=white:` +
      `x=(w-text_w)/2:y=h-120:borderw=3:bordercolor=black@0.7:` +
      `enable='between(t,0.5,${duration - 0.5})'`
    );
  }

  // Format
  filters.push("format=yuv420p");

  args.push("-vf", filters.join(","));

  // Audio/video mapping
  if (audioPath) {
    args.push("-map", "0:v:0", "-map", "1:a:0");
    args.push("-c:a", "aac", "-b:a", AUDIO_BITRATE);
  }

  // Video codec
  args.push("-c:v", "libx264", "-preset", "medium", "-b:v", VIDEO_BITRATE);
  args.push("-pix_fmt", "yuv420p");
  args.push("-shortest");
  args.push("-y", outputPath);

  await runFFmpeg(args, "render-scene");
  return outputPath;
}

// ─────────────────────────────────────────
//  Render subscenes within a chunk
//  Each subscene gets its own visual, then stitched
// ─────────────────────────────────────────

/**
 * Render multiple subscenes for one chunk and stitch them.
 *
 * @param {Object} params
 * @param {Array} params.subsceneAssets - Array of { visualPath, duration, animationStyle, textOverlay }
 * @param {string} params.audioPath - Audio for the entire chunk
 * @param {number} params.totalDuration - Total chunk duration in seconds
 * @param {string} params.outputPath - Output MP4 path
 * @param {Array} params.microTransitions - Array of transition objects between subscenes
 * @returns {Promise<string>} output path
 */
export async function renderSubscenes({
  subsceneAssets,
  audioPath,
  totalDuration,
  outputPath,
  microTransitions = [],
}) {
  if (subsceneAssets.length === 0) {
    throw new Error("No subscene assets to render");
  }

  if (subsceneAssets.length === 1) {
    // Single subscene — render directly
    return renderSceneClip({
      visualPath: subsceneAssets[0].visualPath,
      audioPath,
      duration: totalDuration,
      animationStyle: subsceneAssets[0].animationStyle || "fade",
      outputPath,
      textOverlay: subsceneAssets[0].textOverlay || "",
    });
  }

  // Multiple subscenes: render each without audio, then stitch + add audio

  const tempDir = path.join(OUTPUT_DIR, `temp_${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  // Distribute duration across subscenes
  const totalHint = subsceneAssets.reduce((sum, s) => sum + (s.duration || 4), 0);
  const durations = subsceneAssets.map((s) => {
    const hint = s.duration || 4;
    return (hint / totalHint) * totalDuration;
  });

  const clipPaths = [];

  for (let i = 0; i < subsceneAssets.length; i++) {
    const clipPath = path.join(tempDir, `subscene_${i}.mp4`);
    await renderSceneClip({
      visualPath: subsceneAssets[i].visualPath,
      audioPath: null, // No audio per subscene
      duration: durations[i],
      animationStyle: subsceneAssets[i].animationStyle || "fade",
      outputPath: clipPath,
      textOverlay: subsceneAssets[i].textOverlay || "",
    });
    clipPaths.push(clipPath);
  }

  // Stitch subscene clips using concat
  const concatPath = path.join(tempDir, "concat.txt");
  const concatContent = clipPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
  await fs.writeFile(concatPath, concatContent);

  const mergedVideoPath = path.join(tempDir, "merged_video.mp4");
  await runFFmpeg([
    "-f", "concat", "-safe", "0",
    "-i", concatPath,
    "-c", "copy",
    "-y", mergedVideoPath,
  ], "concat-subscenes");

  // Add audio to merged video
  if (audioPath) {
    await runFFmpeg([
      "-i", mergedVideoPath,
      "-i", audioPath,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", AUDIO_BITRATE,
      "-shortest",
      "-y", outputPath,
    ], "add-audio");
  } else {
    await fs.copyFile(mergedVideoPath, outputPath);
  }

  // Clean up temp
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  return outputPath;
}

// ─────────────────────────────────────────
//  Stitch all scene clips into final video
//  Applies transitions between scenes
// ─────────────────────────────────────────

/**
 * Stitch scene clips into final video with transitions.
 *
 * @param {Array<string>} clipPaths - Array of scene clip MP4 paths
 * @param {Array<Object>} transitions - Transition objects for each cut
 * @param {string} outputPath - Final MP4 output path
 * @returns {Promise<string>} output path
 */
export async function stitchScenes(clipPaths, transitions = [], outputPath) {
  if (clipPaths.length === 0) {
    throw new Error("No clips to stitch");
  }

  if (clipPaths.length === 1) {
    await fs.copyFile(clipPaths[0], outputPath);
    return outputPath;
  }

  // For simplicity and reliability, use concat with xfade filter
  // FFmpeg xfade works pair-wise, so we chain them

  // Strategy: Use concat protocol for clips without complex transitions,
  // or use xfade filter for smooth transitions

  const hasTransitions = transitions.length > 0;

  if (!hasTransitions) {
    // Simple concatenation
    const tempDir = path.join(OUTPUT_DIR, `stitch_${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const concatPath = path.join(tempDir, "concat.txt");
    const concatContent = clipPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
    await fs.writeFile(concatPath, concatContent);

    await runFFmpeg([
      "-f", "concat", "-safe", "0",
      "-i", concatPath,
      "-c", "copy",
      "-y", outputPath,
    ], "simple-stitch");

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return outputPath;
  }

  // With transitions: use xfade filter chain
  // This requires getting the duration of each clip first

  const durations = [];
  for (const clipPath of clipPaths) {
    try {
      const dur = await getAudioDuration(clipPath);
      durations.push(dur);
    } catch {
      durations.push(5); // Fallback 5 seconds
    }
  }

  // Build FFmpeg complex filter with xfade chain
  const args = [];

  // Inputs
  for (const clipPath of clipPaths) {
    args.push("-i", clipPath);
  }

  // Build xfade filter chain
  // [0][1] xfade → [v01]
  // [v01][2] xfade → [v012]
  // etc.

  const filterParts = [];
  let currentOffset = 0;
  let prevLabel = "[0:v]";

  for (let i = 0; i < clipPaths.length - 1; i++) {
    const transition = transitions[i] || { ffmpegFilter: "xfade=transition=fade:duration=0.8" };
    const transitionDuration = (transitions[i]?.duration || 800) / 1000;

    currentOffset += durations[i] - transitionDuration;
    const outLabel = i < clipPaths.length - 2 ? `[v${i}]` : "[vout]";

    filterParts.push(
      `${prevLabel}[${i + 1}:v]${transition.ffmpegFilter}:offset=${currentOffset.toFixed(2)}${outLabel}`
    );

    prevLabel = outLabel;
  }

  // Audio: amerge all audio inputs
  const audioInputs = clipPaths.map((_, i) => `[${i}:a]`).join("");
  filterParts.push(`${audioInputs}concat=n=${clipPaths.length}:v=0:a=1[aout]`);

  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", "[vout]", "-map", "[aout]");
  args.push("-c:v", "libx264", "-preset", "medium", "-b:v", VIDEO_BITRATE);
  args.push("-c:a", "aac", "-b:a", AUDIO_BITRATE);
  args.push("-pix_fmt", "yuv420p");
  args.push("-y", outputPath);

  await runFFmpeg(args, "stitch-with-transitions");
  return outputPath;
}

// ─────────────────────────────────────────
//  Prepare visual asset for rendering
//  Handles SVG→PNG and image download
// ─────────────────────────────────────────

/**
 * Prepare a visual asset for rendering.
 * SVG strings → PNG file, image URLs → downloaded file.
 *
 * @param {Object} params
 * @param {string} params.svgContent - SVG string (if generated)
 * @param {string} params.imageUrl - Image URL (if illustration)
 * @param {string} params.sceneId - Unique scene identifier
 * @returns {Promise<string>} path to the ready-to-use visual file
 */
export async function prepareVisualAsset({ svgContent, imageUrl, sceneId }) {
  const assetDir = path.join(OUTPUT_DIR, "assets");
  if (!existsSync(assetDir)) {
    mkdirSync(assetDir, { recursive: true });
  }

  if (svgContent) {
    const pngPath = path.join(assetDir, `${sceneId}.png`);
    return svgToPng(svgContent, pngPath);
  }

  if (imageUrl) {
    const ext = imageUrl.match(/\.(png|jpg|jpeg|webp)/i)?.[1] || "png";
    const imgPath = path.join(assetDir, `${sceneId}.${ext}`);
    return downloadImage(imageUrl, imgPath);
  }

  throw new Error(`No visual content for scene ${sceneId}`);
}

// ─────────────────────────────────────────
//  Save audio buffer to temp file
// ─────────────────────────────────────────

export async function saveAudioToFile(audioBuffer, sceneId) {
  const audioDir = path.join(OUTPUT_DIR, "audio");
  if (!existsSync(audioDir)) {
    mkdirSync(audioDir, { recursive: true });
  }

  const audioPath = path.join(audioDir, `${sceneId}.wav`);
  await fs.writeFile(audioPath, audioBuffer);
  return audioPath;
}

// ─────────────────────────────────────────
//  Clean up temp files for a job
// ─────────────────────────────────────────

export async function cleanupJobFiles(jobId) {
  const patterns = [
    path.join(OUTPUT_DIR, "assets"),
    path.join(OUTPUT_DIR, "audio"),
  ];

  for (const dir of patterns) {
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (f.startsWith(jobId)) {
          await fs.unlink(path.join(dir, f)).catch(() => {});
        }
      }
    } catch {
      // Directory doesn't exist, that's fine
    }
  }
}

// ─────────────────────────────────────────
//  Get final video file as buffer
// ─────────────────────────────────────────

export async function readVideoFile(videoPath) {
  return fs.readFile(videoPath);
}

export default {
  renderSceneClip,
  renderSubscenes,
  stitchScenes,
  prepareVisualAsset,
  saveAudioToFile,
  getAudioDuration,
  cleanupJobFiles,
  readVideoFile,
  OUTPUT_DIR,
};

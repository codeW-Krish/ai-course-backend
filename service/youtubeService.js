// import axios from "axios";
// const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// export const fetchYoutubeVideos = async(keywords = []) => {
//     if (!keywords) return [];

//     const videos = [];

//     for (const keyword of keywords) {
//         const query = encodeURIComponent(keyword);
//         const maxResult = 1;

//         try {
//             const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
//                 params: {
//                     key: YOUTUBE_API_KEY,
//                     q: query,
//                     part: 'snippet',
//                     maxResult,
//                     type: 'video'
//                 }
//             });

//             const keywordVideos = res.data.items.map(item => ({
//                 title: item.snippet.title,
//                 youtube_url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
//                 thumbnail: item.snippet.thumbnails.default.url,
//                 duration_sec: null // Duration can be fetched later if needed
//             }))

//             videos.push(keywordVideos);
//         } catch (err) {
//             console.error(`Error fetching YouTube videos for keyword "${keyword}":`, err);
//         }
//     }

//     return videos;
// // }






// import axios from 'axios';

// const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;  // YouTube API key from your environment

// // Function to fetch video duration and format it like YouTube
// const fetchVideoDuration = async (videoId) => {
//   try {
//     // Fetch the video details using the 'videos.list' endpoint
//     const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
//       params: {
//         key: YOUTUBE_API_KEY,
//         part: 'contentDetails',  // We need contentDetails to get the duration
//         id: videoId,             // Video ID
//       }
//     });

//     const video = response.data.items[0];  // Extract video data
//     if (video) {
//       const duration = video.contentDetails.duration;  // Duration in ISO 8601 format (e.g., PT15M30S)
//       return formatDuration(duration);  // Format it like YouTube does
//     }
//   } catch (error) {
//     console.error(`Error fetching video duration for ${videoId}:`, error);
//     return null;  // Return null if there's an error fetching duration
//   }
// };

// // Function to convert ISO 8601 duration to a human-readable format
// const formatDuration = (isoDuration) => {
//   let duration = isoDuration.replace('PT', '');  // Remove the 'PT' part

//   const hoursMatch = duration.match(/(\d+)H/);
//   const minutesMatch = duration.match(/(\d+)M/);
//   const secondsMatch = duration.match(/(\d+)S/);

//   const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
//   const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
//   const seconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 0;

//   // Return a formatted string (like "1:02:03" or "5:20")
//   return `${hours > 0 ? `${hours}:` : ''}${minutes < 10 && hours > 0 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
// };

// // Function to fetch YouTube videos based on keywords and their details (including duration)
// export const fetchYoutubeVideos = async (keywords = []) => {
//   if (!keywords || keywords.length === 0) return [];

//   const allVideos = [];

//   for (const keyword of keywords) {
//     const query = encodeURIComponent(keyword);  // URL encode the query keyword
//     const maxResult = 3;  // Adjust max results as needed

//     try {
//       // Step 1: Fetch search results using YouTube's search API
//       const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
//         params: {
//           key: YOUTUBE_API_KEY,
//           q: query,              // The keyword to search for
//           part: 'snippet',       // What data to retrieve (just snippet in this case)
//           maxResults: maxResult, // Max results per keyword
//           type: 'video'          // We only want videos, not channels or playlists
//         }
//       });

//       // Step 2: For each video in the search results, fetch video details (including duration)
//       const videoDetails = await Promise.all(
//         searchResponse.data.items.map(async (item) => {
//           const videoId = item.id.videoId;
//           const duration = await fetchVideoDuration(videoId);  // Get the duration of the video

//           // Return video data
//           return {
//             title: item.snippet.title,
//             youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
//             thumbnail: item.snippet.thumbnails.default.url,
//             duration: duration || 'N/A',  // Show "N/A" if duration fetch fails
//           };
//         })
//       );

//       allVideos.push(...videoDetails);  // Add video details to the list
//     } catch (err) {
//       console.error(`Error fetching YouTube videos for keyword "${keyword}":`, err);
//     }
//   }

//   return allVideos;  // Return the list of videos with details
// };


//------------------------------------------------------------------------------------------

// import axios from 'axios';

// const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;  // Make sure this is set in your environment

// // ✅ Function to convert ISO 8601 duration to total seconds
// const parseISODurationToSeconds = (isoDuration) => {
//   const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
//   if (!match) return 0;

//   const hours = parseInt(match[1] || "0", 10);
//   const minutes = parseInt(match[2] || "0", 10);
//   const seconds = parseInt(match[3] || "0", 10);

//   return hours * 3600 + minutes * 60 + seconds;
// };

// // ✅ Fetch duration in seconds from YouTube
// const fetchVideoDuration = async (videoId) => {
//   try {
//     const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
//       params: {
//         key: YOUTUBE_API_KEY,
//         part: 'contentDetails',
//         id: videoId,
//       }
//     });

//     const video = response.data.items[0];
//     if (video) {
//       const isoDuration = video.contentDetails.duration;
//       return parseISODurationToSeconds(isoDuration);  // ✅ return seconds (int)
//     }
//   } catch (error) {
//     console.error(`❌ Error fetching video duration for ${videoId}:`, error);
//     return null;
//   }
// };

// // ✅ Main function to fetch YouTube videos with duration in seconds
// export const fetchYoutubeVideos = async (keywords = []) => {
//   if (!keywords || keywords.length === 0) return [];

//   const allVideos = [];

//   for (const keyword of keywords) {
//     const query = encodeURIComponent(keyword);
//     const maxResult = 3;

//     try {
//       // Step 1: Search for videos
//       const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
//         params: {
//           key: YOUTUBE_API_KEY,
//           q: query,
//           part: 'snippet',
//           maxResults: maxResult,
//           type: 'video',
//           videoDuration: "medium",
//           videoDefinition: 'high',
//           order: 'relevance'
//         }
//       });

//       // Step 2: Fetch details (duration)
//       const videoDetails = await Promise.all(
//         searchResponse.data.items.map(async (item) => {
//           const videoId = item.id.videoId;
//           const duration_sec = await fetchVideoDuration(videoId);  // ✅ seconds

//           return {
//             title: item.snippet.title,
//             youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
//             thumbnail: item.snippet.thumbnails.default.url,
//             duration_sec: duration_sec || 0,  // ✅ always return seconds as a number
//           };
//         })
//       );

//       allVideos.push(...videoDetails);
//     } catch (err) {
//       console.error(`❌ Error fetching YouTube videos for keyword "${keyword}":`, err);
//     }
//   }

//   return allVideos;
// };

//------------------------------------------------------------------------------------------
import axios from 'axios';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// --- Helper: convert ISO 8601 duration to seconds ---
const parseISODurationToSeconds = (iso) => {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const [h, m, s] = [match[1] || 0, match[2] || 0, match[3] || 0].map(Number);
  return h * 3600 + m * 60 + s;
};

// --- Bulk fetch durations for multiple video IDs ---
const fetchVideoDurations = async (videoIds = []) => {
  if (!videoIds.length) return {};
  try {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        key: YOUTUBE_API_KEY,
        part: 'contentDetails',
        id: videoIds.join(','),
      },
    });

    return data.items.reduce((acc, item) => {
      acc[item.id] = parseISODurationToSeconds(item.contentDetails.duration);
      return acc;
    }, {});
  } catch (e) {
    console.error('Failed to fetch video durations:', e.message);
    return {};
  }
};

// --- Fetch YouTube videos (optimized for best results) ---
export const fetchYoutubeVideos = async (keywords = []) => {
  if (!keywords.length) return [];

  const searchPromises = keywords.map(async (keyword) => {
    try {
      const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          key: YOUTUBE_API_KEY,
          q: keyword,
          part: 'snippet',
          maxResults: 30,          // fetch more to pick the best
          type: 'video',
          videoDuration: 'medium', // 4–20 min
          videoDefinition: 'high',
          order: 'relevance',
        },
      });

      const videoIds = data.items.map(item => item.id.videoId);
      const durationsMap = await fetchVideoDurations(videoIds);

      return data.items
        .map(item => {
          const duration = durationsMap[item.id.videoId] || 0;
          return {
            title: item.snippet.title,
            youtube_url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default.url,
            duration_sec: duration,
          };
        })
        .filter(v => v.duration_sec >= 120 && v.duration_sec <= 1200) // 2–20 min
        .slice(0, 4); // top 4 per keyword
    } catch (e) {
      console.error(`YouTube search failed for "${keyword}":`, e.message);
      return [];
    }
  });

  const results = await Promise.all(searchPromises);
  return results.flat();
};
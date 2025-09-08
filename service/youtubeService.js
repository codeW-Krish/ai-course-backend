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
// }
import axios from 'axios';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;  // YouTube API key from your environment

// Function to fetch video duration and format it like YouTube
const fetchVideoDuration = async (videoId) => {
  try {
    // Fetch the video details using the 'videos.list' endpoint
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        key: YOUTUBE_API_KEY,
        part: 'contentDetails',  // We need contentDetails to get the duration
        id: videoId,             // Video ID
      }
    });

    const video = response.data.items[0];  // Extract video data
    if (video) {
      const duration = video.contentDetails.duration;  // Duration in ISO 8601 format (e.g., PT15M30S)
      return formatDuration(duration);  // Format it like YouTube does
    }
  } catch (error) {
    console.error(`Error fetching video duration for ${videoId}:`, error);
    return null;  // Return null if there's an error fetching duration
  }
};

// Function to convert ISO 8601 duration to a human-readable format
const formatDuration = (isoDuration) => {
  let duration = isoDuration.replace('PT', '');  // Remove the 'PT' part

  const hoursMatch = duration.match(/(\d+)H/);
  const minutesMatch = duration.match(/(\d+)M/);
  const secondsMatch = duration.match(/(\d+)S/);

  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
  const seconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 0;

  // Return a formatted string (like "1:02:03" or "5:20")
  return `${hours > 0 ? `${hours}:` : ''}${minutes < 10 && hours > 0 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
};

// Function to fetch YouTube videos based on keywords and their details (including duration)
export const fetchYoutubeVideos = async (keywords = []) => {
  if (!keywords || keywords.length === 0) return [];

  const allVideos = [];

  for (const keyword of keywords) {
    const query = encodeURIComponent(keyword);  // URL encode the query keyword
    const maxResult = 3;  // Adjust max results as needed

    try {
      // Step 1: Fetch search results using YouTube's search API
      const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          key: YOUTUBE_API_KEY,
          q: query,              // The keyword to search for
          part: 'snippet',       // What data to retrieve (just snippet in this case)
          maxResults: maxResult, // Max results per keyword
          type: 'video'          // We only want videos, not channels or playlists
        }
      });

      // Step 2: For each video in the search results, fetch video details (including duration)
      const videoDetails = await Promise.all(
        searchResponse.data.items.map(async (item) => {
          const videoId = item.id.videoId;
          const duration = await fetchVideoDuration(videoId);  // Get the duration of the video

          // Return video data
          return {
            title: item.snippet.title,
            youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
            thumbnail: item.snippet.thumbnails.default.url,
            duration: duration || 'N/A',  // Show "N/A" if duration fetch fails
          };
        })
      );

      allVideos.push(...videoDetails);  // Add video details to the list
    } catch (err) {
      console.error(`Error fetching YouTube videos for keyword "${keyword}":`, err);
    }
  }

  return allVideos;  // Return the list of videos with details
};



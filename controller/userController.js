import { db, FieldValue } from "../db/firebase.js";
import { serializeTimestamps } from "../utils/firestoreSerializer.js";

const usersRef = db.collection("users");

// ============================================================
//  GET /api/users/me — Get own profile
// ============================================================
export const getMyProfile = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const userDoc = await usersRef.doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const data = userDoc.data();

    // Get follower/following counts
    const followersSnap = await db.collection("follows").where("following_id", "==", userId).get();
    const followingSnap = await db.collection("follows").where("follower_id", "==", userId).get();

    // Get course count
    const coursesSnap = await db.collection("courses").where("created_by", "==", userId).get();

    const profile = {
      id: userId,
      username: data.username || "User",
      email: data.email,
      role: data.role || "user",
      profile_image_url: data.profile_image_url || null,
      bio: data.bio || null,
      created_at: data.created_at,
      followers_count: followersSnap.size,
      following_count: followingSnap.size,
      courses_count: coursesSnap.size,
    };

    return res.status(200).json(serializeTimestamps(profile));
  } catch (err) {
    console.error("getMyProfile error:", err);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
};

// ============================================================
//  PUT /api/users/me — Update own profile
// ============================================================
export const updateMyProfile = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { username, bio, profile_image_url } = req.body;
    const updates = {};

    if (username !== undefined) {
      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: "Username must be 3-30 characters" });
      }
      // Check uniqueness
      const existing = await usersRef.where("username", "==", username).limit(1).get();
      if (!existing.empty && existing.docs[0].id !== userId) {
        return res.status(409).json({ error: "Username already taken" });
      }
      updates.username = username;
    }
    if (bio !== undefined) updates.bio = bio;
    if (profile_image_url !== undefined) updates.profile_image_url = profile_image_url;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    updates.updated_at = new Date();
    await usersRef.doc(userId).update(updates);

    return res.status(200).json({ message: "Profile updated", ...updates });
  } catch (err) {
    console.error("updateMyProfile error:", err);
    return res.status(500).json({ error: "Failed to update profile" });
  }
};

// ============================================================
//  GET /api/users/:userId/profile — View any user's public profile
// ============================================================
export const getUserProfile = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user?.id;

    const userDoc = await usersRef.doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const data = userDoc.data();

    // Get follower/following counts
    const followersSnap = await db.collection("follows").where("following_id", "==", userId).get();
    const followingSnap = await db.collection("follows").where("follower_id", "==", userId).get();

    // Get public courses
    const coursesSnap = await db.collection("courses")
      .where("created_by", "==", userId)
      .where("is_public", "==", true)
      .orderBy("created_at", "desc")
      .get();

    const courses = coursesSnap.docs.map((doc) => serializeTimestamps({
      id: doc.id,
      title: doc.data().title,
      description: doc.data().description,
      difficulty: doc.data().difficulty,
      status: doc.data().status,
      created_at: doc.data().created_at,
    }));

    // Check if current user follows this user
    let is_following = false;
    if (currentUserId && currentUserId !== userId) {
      const followId = `${currentUserId}_${userId}`;
      const followDoc = await db.collection("follows").doc(followId).get();
      is_following = followDoc.exists;
    }

    const profile = {
      id: userId,
      username: data.username || "User",
      profile_image_url: data.profile_image_url || null,
      bio: data.bio || null,
      created_at: data.created_at,
      followers_count: followersSnap.size,
      following_count: followingSnap.size,
      courses_count: coursesSnap.size,
      courses,
      is_following,
      is_own_profile: currentUserId === userId,
    };

    return res.status(200).json(serializeTimestamps(profile));
  } catch (err) {
    console.error("getUserProfile error:", err);
    return res.status(500).json({ error: "Failed to fetch user profile" });
  }
};

// ============================================================
//  POST /api/users/:userId/follow — Follow a user
// ============================================================
export const followUser = async (req, res) => {
  try {
    const currentUserId = req.user?.id;
    const { userId } = req.params;

    if (!currentUserId) return res.status(401).json({ error: "Unauthorized" });
    if (currentUserId === userId) return res.status(400).json({ error: "Cannot follow yourself" });

    // Check target user exists
    const targetDoc = await usersRef.doc(userId).get();
    if (!targetDoc.exists) return res.status(404).json({ error: "User not found" });

    const followId = `${currentUserId}_${userId}`;
    const existingFollow = await db.collection("follows").doc(followId).get();

    if (existingFollow.exists) {
      return res.status(409).json({ error: "Already following this user" });
    }

    await db.collection("follows").doc(followId).set({
      follower_id: currentUserId,
      following_id: userId,
      created_at: new Date(),
    });

    return res.status(200).json({ message: "Followed successfully" });
  } catch (err) {
    console.error("followUser error:", err);
    return res.status(500).json({ error: "Failed to follow user" });
  }
};

// ============================================================
//  DELETE /api/users/:userId/follow — Unfollow a user
// ============================================================
export const unfollowUser = async (req, res) => {
  try {
    const currentUserId = req.user?.id;
    const { userId } = req.params;

    if (!currentUserId) return res.status(401).json({ error: "Unauthorized" });

    const followId = `${currentUserId}_${userId}`;
    const followDoc = await db.collection("follows").doc(followId).get();

    if (!followDoc.exists) {
      return res.status(400).json({ error: "Not following this user" });
    }

    await db.collection("follows").doc(followId).delete();

    return res.status(200).json({ message: "Unfollowed successfully" });
  } catch (err) {
    console.error("unfollowUser error:", err);
    return res.status(500).json({ error: "Failed to unfollow user" });
  }
};

// ============================================================
//  GET /api/users/:userId/followers — Get user's followers
// ============================================================
export const getFollowers = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user?.id;

    const followsSnap = await db.collection("follows")
      .where("following_id", "==", userId)
      .orderBy("created_at", "desc")
      .get();

    const followers = [];
    for (const doc of followsSnap.docs) {
      const followerId = doc.data().follower_id;
      const userDoc = await usersRef.doc(followerId).get();
      if (!userDoc.exists) continue;

      let is_following_back = false;
      if (currentUserId) {
        const reverseId = `${currentUserId}_${followerId}`;
        const reverseDoc = await db.collection("follows").doc(reverseId).get();
        is_following_back = reverseDoc.exists;
      }

      followers.push({
        id: followerId,
        username: userDoc.data().username || "User",
        profile_image_url: userDoc.data().profile_image_url || null,
        is_following: is_following_back,
      });
    }

    return res.status(200).json({ followers, count: followers.length });
  } catch (err) {
    console.error("getFollowers error:", err);
    return res.status(500).json({ error: "Failed to fetch followers" });
  }
};

// ============================================================
//  GET /api/users/:userId/following — Get who user follows
// ============================================================
export const getFollowing = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user?.id;

    const followsSnap = await db.collection("follows")
      .where("follower_id", "==", userId)
      .orderBy("created_at", "desc")
      .get();

    const following = [];
    for (const doc of followsSnap.docs) {
      const followingId = doc.data().following_id;
      const userDoc = await usersRef.doc(followingId).get();
      if (!userDoc.exists) continue;

      let is_following_them = false;
      if (currentUserId) {
        const checkId = `${currentUserId}_${followingId}`;
        const checkDoc = await db.collection("follows").doc(checkId).get();
        is_following_them = checkDoc.exists;
      }

      following.push({
        id: followingId,
        username: userDoc.data().username || "User",
        profile_image_url: userDoc.data().profile_image_url || null,
        is_following: is_following_them,
      });
    }

    return res.status(200).json({ following, count: following.length });
  } catch (err) {
    console.error("getFollowing error:", err);
    return res.status(500).json({ error: "Failed to fetch following" });
  }
};

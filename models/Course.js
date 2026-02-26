import { db, FieldValue } from "../db/firebase.js";

const coursesRef = db.collection("courses");

const Course = {
    /**
     * Find all courses with creator info (for admin panel)
     */
    findAll: async () => {
        const snapshot = await coursesRef.orderBy("created_at", "desc").get();
        const courses = [];

        for (const doc of snapshot.docs) {
            const course = { id: doc.id, ...doc.data() };

            // Fetch creator username
            if (course.created_by) {
                const userDoc = await db.collection("users").doc(course.created_by).get();
                course.creator_username = userDoc.exists ? userDoc.data().username : "Unknown";
            }

            courses.push(course);
        }

        return courses;
    },

    /**
     * Find course by ID with full nested data (units → subtopics → videos)
     */
    findById: async (courseId) => {
        const courseDoc = await coursesRef.doc(courseId).get();
        if (!courseDoc.exists) return null;

        const course = { id: courseDoc.id, ...courseDoc.data() };

        // Fetch creator info
        if (course.created_by) {
            const userDoc = await db.collection("users").doc(course.created_by).get();
            course.creator_username = userDoc.exists ? userDoc.data().username : "Unknown";
        }

        // Fetch units (ordered by position)
        const unitsSnapshot = await coursesRef
            .doc(courseId)
            .collection("units")
            .orderBy("position")
            .get();

        course.units = [];

        for (const unitDoc of unitsSnapshot.docs) {
            const unit = { id: unitDoc.id, ...unitDoc.data() };

            // Fetch subtopics for each unit (ordered by position)
            const subtopicsSnapshot = await coursesRef
                .doc(courseId)
                .collection("units")
                .doc(unitDoc.id)
                .collection("subtopics")
                .orderBy("position")
                .get();

            unit.subtopics = [];

            for (const subDoc of subtopicsSnapshot.docs) {
                const subtopic = { id: subDoc.id, ...subDoc.data() };

                // Fetch videos for each subtopic
                const videosSnapshot = await coursesRef
                    .doc(courseId)
                    .collection("units")
                    .doc(unitDoc.id)
                    .collection("subtopics")
                    .doc(subDoc.id)
                    .collection("videos")
                    .get();

                subtopic.videos = videosSnapshot.docs.map((v) => ({
                    id: v.id,
                    ...v.data(),
                }));

                unit.subtopics.push(subtopic);
            }

            course.units.push(unit);
        }

        return course;
    },

    /**
     * Delete a course and all its subcollections
     */
    delete: async (courseId) => {
        // Delete nested subcollections first (Firestore doesn't cascade)
        const unitsSnapshot = await coursesRef.doc(courseId).collection("units").get();

        for (const unitDoc of unitsSnapshot.docs) {
            const subtopicsSnapshot = await coursesRef
                .doc(courseId)
                .collection("units")
                .doc(unitDoc.id)
                .collection("subtopics")
                .get();

            for (const subDoc of subtopicsSnapshot.docs) {
                // Delete videos subcollection
                const videosSnapshot = await coursesRef
                    .doc(courseId)
                    .collection("units")
                    .doc(unitDoc.id)
                    .collection("subtopics")
                    .doc(subDoc.id)
                    .collection("videos")
                    .get();

                const videoBatch = db.batch();
                videosSnapshot.docs.forEach((v) => videoBatch.delete(v.ref));
                await videoBatch.commit();

                // Delete subtopic
                await subDoc.ref.delete();
            }

            // Delete unit
            await unitDoc.ref.delete();
        }

        // Delete related data in top-level collections
        const cleanupCollections = [
            { collection: "user_courses", field: "course_id" },
            { collection: "user_progress", field: "course_id" },
            { collection: "course_reviews", field: "course_id" },
        ];

        for (const { collection, field } of cleanupCollections) {
            const snapshot = await db.collection(collection).where(field, "==", courseId).get();
            const batch = db.batch();
            snapshot.docs.forEach((doc) => batch.delete(doc.ref));
            if (!snapshot.empty) await batch.commit();
        }

        // Delete course_public_stats and course_generation_status docs
        await db.collection("course_public_stats").doc(courseId).delete().catch(() => { });
        await db.collection("course_generation_status").doc(courseId).delete().catch(() => { });

        // Finally delete the course document
        await coursesRef.doc(courseId).delete();

        return true;
    },

    /**
     * Alias: findAllWithUsers (called by admin routes)
     */
    findAllWithUsers: async () => {
        return Course.findAll();
    },

    /**
     * Alias: deleteById (called by admin routes)
     */
    deleteById: async (courseId) => {
        return Course.delete(courseId);
    },
};

export default Course;
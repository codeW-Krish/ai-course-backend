/**
 * Recursively converts Firestore Timestamp objects (with _seconds/_nanoseconds
 * or toDate()) into ISO string format so JSON responses don't break clients
 * that expect string timestamps.
 */
export function serializeTimestamps(obj) {
    if (obj === null || obj === undefined) return obj;

    // Firestore Timestamp object (has toDate method)
    if (typeof obj?.toDate === "function") {
        return obj.toDate().toISOString();
    }

    // Raw Firestore timestamp shape: { _seconds, _nanoseconds }
    if (
        typeof obj === "object" &&
        typeof obj._seconds === "number" &&
        typeof obj._nanoseconds === "number" &&
        Object.keys(obj).length <= 2
    ) {
        return new Date(obj._seconds * 1000 + obj._nanoseconds / 1e6).toISOString();
    }

    // Date object
    if (obj instanceof Date) {
        return obj.toISOString();
    }

    // Array
    if (Array.isArray(obj)) {
        return obj.map(serializeTimestamps);
    }

    // Plain object — recurse
    if (typeof obj === "object") {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = serializeTimestamps(value);
        }
        return result;
    }

    return obj;
}

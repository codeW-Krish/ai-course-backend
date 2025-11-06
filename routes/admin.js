import express from 'express';
import { adminMiddleware } from '../middleware/adminMiddleware.js';
import GlobalSettings from '../models/GlobalSettings.js';
import Course from '../models/Course.js'; // You'll need to create this model

const router = express.Router();

// Get all courses (admin only)
router.get('/courses', adminMiddleware, async (req, res) => {
    try {
        // You'll need to implement this in your Course model
        const courses = await Course.findAllWithUsers();
        res.json({ courses });
    } catch (error) {
        console.error('Admin courses error:', error);
        res.status(500).json({ error: 'Failed to fetch courses' });
    }
});

// Delete any course (admin only)
router.delete('/courses/:id', adminMiddleware, async (req, res) => {
    try {
        const courseId = req.params.id;
        await Course.deleteById(courseId);
        res.json({ message: 'Course deleted successfully' });
    } catch (error) {
        console.error('Admin delete course error:', error);
        res.status(500).json({ error: 'Failed to delete course' });
    }
});

// Get global settings (admin only)
router.get('/settings', adminMiddleware, async (req, res) => {
    try {
        const settings = await GlobalSettings.getAll();
        res.json({ settings });
    } catch (error) {
        console.error('Admin settings error:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Update global settings (admin only)
router.put('/settings/:key', adminMiddleware, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        
        const updated = await GlobalSettings.update(key, value, req.user.id);
        res.json({ 
            message: 'Setting updated successfully', 
            setting: updated 
        });
    } catch (error) {
        console.error('Admin update settings error:', error);
        res.status(500).json({ error: 'Failed to update setting' });
    }
});

// Update available providers (admin only)
router.put('/providers/available', adminMiddleware, async (req, res) => {
    try {
        const { providers } = req.body;
        
        if (!Array.isArray(providers)) {
            return res.status(400).json({ error: 'Providers must be an array' });
        }

        const updated = await GlobalSettings.update(
            'available_providers', 
            JSON.stringify(providers), 
            req.user.id
        );
        
        res.json({ 
            message: 'Available providers updated successfully', 
            providers: JSON.parse(updated.value)
        });
    } catch (error) {
        console.error('Admin update providers error:', error);
        res.status(500).json({ error: 'Failed to update providers' });
    }
});

// Update default providers (admin only)
router.put('/providers/default', adminMiddleware, async (req, res) => {
    try {
        const { outlineProvider, contentProvider } = req.body;
        
        // Validate providers against available ones
        const availableProviders = await GlobalSettings.getAvailableProviders();
        
        if (!availableProviders.includes(outlineProvider)) {
            return res.status(400).json({ error: 'Invalid outline provider' });
        }
        
        if (!availableProviders.includes(contentProvider)) {
            return res.status(400).json({ error: 'Invalid content provider' });
        }

        await Promise.all([
            GlobalSettings.update('default_outline_provider', outlineProvider, req.user.id),
            GlobalSettings.update('default_content_provider', contentProvider, req.user.id)
        ]);
        
        res.json({ 
            message: 'Default providers updated successfully',
            outlineProvider,
            contentProvider
        });
    } catch (error) {
        console.error('Admin update default providers error:', error);
        res.status(500).json({ error: 'Failed to update default providers' });
    }
});

export default router;
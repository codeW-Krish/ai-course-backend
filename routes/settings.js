import express from 'express';
import GlobalSettings from '../models/GlobalSettings.js';

const router = express.Router();

// Get available providers (public)
router.get('/providers/available', async (req, res) => {
    try {
        const providers = await GlobalSettings.getAvailableProviders();
        res.json({ providers });
    } catch (error) {
        console.error('Available providers error:', error);
        res.status(500).json({ error: 'Failed to fetch available providers' });
    }
});

// Get default providers (public)
router.get('/providers/default', async (req, res) => {
    try {
        const providers = await GlobalSettings.getDefaultProviders();
        res.json(providers);
    } catch (error) {
        console.error('Default providers error:', error);
        res.status(500).json({ error: 'Failed to fetch default providers' });
    }
});

export default router;
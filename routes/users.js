const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

// Get user profile
router.get("/profile", authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM users WHERE firebase_uid = $1",
      [req.user.uid]
    );

    if (result.rows.length === 0) {
      // Create user if doesn't exist
      const newUser = await db.query(
        `INSERT INTO users (firebase_uid, email, display_name) 
         VALUES ($1, $2, $3) RETURNING *`,
        [req.user.uid, req.user.email, req.user.name || req.user.email]
      );
      return res.json(newUser.rows[0]);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching user profile:", error);
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

// Update user profile
router.put("/profile", authenticateToken, async (req, res) => {
  try {
    const { display_name, profile_image_url, is_public } = req.body;

    const result = await db.query(
      `UPDATE users SET 
       display_name = COALESCE($1, display_name),
       profile_image_url = COALESCE($2, profile_image_url),
       is_public = COALESCE($3, is_public),
       updated_at = CURRENT_TIMESTAMP
       WHERE firebase_uid = $4 RETURNING *`,
      [display_name, profile_image_url, is_public, req.user.uid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating user profile:", error);
    res.status(500).json({ error: "Failed to update user profile" });
  }
});

// Get user stats
router.get("/stats", authenticateToken, async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_trips,
        COUNT(DISTINCT country) as countries_visited,
        COALESCE(SUM(likes_count), 0) as total_likes
      FROM trips 
      WHERE user_id = (
        SELECT id FROM users WHERE firebase_uid = $1
      )
    `;

    const result = await db.query(statsQuery, [req.user.uid]);
    const stats = result.rows[0];

    // Convert string numbers to integers
    res.json({
      total_trips: parseInt(stats.total_trips) || 0,
      countries_visited: parseInt(stats.countries_visited) || 0,
      total_likes: parseInt(stats.total_likes) || 0,
    });
  } catch (error) {
    console.error("Error fetching user stats:", error);
    res.status(500).json({ error: "Failed to fetch user stats" });
  }
});

module.exports = router;

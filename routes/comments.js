const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

// Get comments for a trip
router.get("/trips/:tripId", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.*, u.display_name as user_name, u.profile_image_url
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.trip_id = $1
       ORDER BY c.created_at DESC`,
      [req.params.tripId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching comments:", error);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// Add comment to trip
router.post("/trips/:tripId", authenticateToken, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: "Comment content is required" });
    }

    // Get user ID
    const userResult = await db.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [req.user.uid]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userResult.rows[0].id;

    const result = await db.query(
      `INSERT INTO comments (trip_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.params.tripId, userId, content.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error adding comment:", error);
    res.status(500).json({ error: "Failed to add comment" });
  }
});

// Delete comment
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM comments 
       WHERE id = $1 AND user_id = (
         SELECT id FROM users WHERE firebase_uid = $2
       )
       RETURNING id`,
      [req.params.id, req.user.uid]
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Comment not found or unauthorized" });
    }

    res.json({ message: "Comment deleted successfully" });
  } catch (error) {
    console.error("Error deleting comment:", error);
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");

// Verify token endpoint
router.post("/verify", authenticateToken, (req, res) => {
  res.json({
    valid: true,
    user: {
      uid: req.user.uid,
      email: req.user.email,
      name: req.user.name,
    },
  });
});

module.exports = router;

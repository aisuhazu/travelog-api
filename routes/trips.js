const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

// Get all trips for authenticated user
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 10, search, country } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT t.*, u.display_name as user_name
      FROM trips t
      JOIN users u ON t.user_id = u.id
      WHERE u.firebase_uid = $1
    `;

    const params = [req.user.uid];
    let paramCount = 1;

    if (search) {
      paramCount++;
      query += ` AND (t.title ILIKE $${paramCount} OR t.destination ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    if (country) {
      paramCount++;
      query += ` AND t.country ILIKE $${paramCount}`;
      params.push(`%${country}%`);
    }

    query += ` ORDER BY t.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    
    // Get gallery images for each trip
    const tripsWithData = await Promise.all(result.rows.map(async (trip) => {
      const galleryResult = await db.query(
        `SELECT id, url, path, filename, original_name, order_index, uploaded_at 
         FROM trip_gallery_images 
         WHERE trip_id = $1 
         ORDER BY order_index ASC, uploaded_at ASC`,
        [trip.id]
      );
      
      return {
        ...trip,
        coordinates: trip.latitude && trip.longitude ? {
          lat: parseFloat(trip.latitude),
          lng: parseFloat(trip.longitude)
        } : null,
        gallery_images: galleryResult.rows
      };
    }));
    
    res.json(tripsWithData);
  } catch (error) {
    console.error("Error fetching trips:", error);
    res.status(500).json({ error: "Failed to fetch trips" });
  }
});

// Get single trip
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT t.*, u.display_name as user_name
       FROM trips t
       JOIN users u ON t.user_id = u.id
       WHERE t.id = $1 AND u.firebase_uid = $2`,
      [req.params.id, req.user.uid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const trip = result.rows[0];
    
    // Get gallery images for this trip
    const galleryResult = await db.query(
      `SELECT id, url, path, filename, original_name, order_index, uploaded_at 
       FROM trip_gallery_images 
       WHERE trip_id = $1 
       ORDER BY order_index ASC, uploaded_at ASC`,
      [trip.id]
    );
    
    const tripWithData = {
      ...trip,
      coordinates: trip.latitude && trip.longitude ? {
        lat: parseFloat(trip.latitude),
        lng: parseFloat(trip.longitude)
      } : null,
      gallery_images: galleryResult.rows
    };

    res.json(tripWithData);
  } catch (error) {
    console.error("Error fetching trip:", error);
    res.status(500).json({ error: "Failed to fetch trip" });
  }
});

// Create new trip
router.post("/", authenticateToken, async (req, res) => {
  try {
    const {
      title,
      destination,
      country,
      coordinates,
      latitude,
      longitude,
      start_date,
      end_date,
      description,
      notes,
      tags,
      images,
      is_public,
      status,
      budget,
      cover_image,
      cover_image_path,
      gallery_images
    } = req.body;

    // Validate required fields
    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: "Title is required" });
    }

    if (!destination || destination.trim().length === 0) {
      return res.status(400).json({ error: "Destination is required" });
    }

    // Handle coordinates from frontend (coordinates object takes priority)
    const finalLatitude = coordinates?.lat || latitude || null;
    const finalLongitude = coordinates?.lng || longitude || null;

    // Auto-extract country if not provided but coordinates are available
    let finalCountry = country;
    if (!finalCountry && finalLatitude && finalLongitude) {
      try {
        const response = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${finalLatitude}&longitude=${finalLongitude}&localityLanguage=en`
        );
        if (response.ok) {
          const data = await response.json();
          finalCountry = data.countryName || null;
        }
      } catch (error) {
        console.error("Error extracting country:", error);
      }
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

    // Start transaction
    await db.query('BEGIN');

    try {
      // Create trip
      const result = await db.query(
        `INSERT INTO trips (
          user_id, title, destination, country, latitude, longitude,
          start_date, end_date, description, notes, tags, images, is_public,
          cover_image, cover_image_path
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [
          userId,
          title.trim(),
          destination.trim(),
          finalCountry,
          finalLatitude,
          finalLongitude,
          start_date,
          end_date,
          description,
          notes,
          tags || [],
          images || [],
          is_public || false,
          cover_image || null,
          cover_image_path || null
        ]
      );

      const trip = result.rows[0];
      
      // Add gallery images if provided
      const galleryImagesData = [];
      if (gallery_images && Array.isArray(gallery_images)) {
        for (let i = 0; i < gallery_images.length; i++) {
          const image = gallery_images[i];
          const galleryResult = await db.query(
            `INSERT INTO trip_gallery_images (
              trip_id, url, path, filename, original_name, order_index
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
            [
              trip.id,
              image.url,
              image.path,
              image.filename,
              image.original_name || image.filename,
              image.order_index || i
            ]
          );
          galleryImagesData.push(galleryResult.rows[0]);
        }
      }

      await db.query('COMMIT');
      
      // Return trip with coordinates and gallery images
      const tripWithData = {
        ...trip,
        coordinates: trip.latitude && trip.longitude ? {
          lat: parseFloat(trip.latitude),
          lng: parseFloat(trip.longitude)
        } : null,
        gallery_images: galleryImagesData
      };

      res.status(201).json(tripWithData);
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error("Error creating trip:", error);
    res.status(500).json({ error: "Failed to create trip" });
  }
});

// Update trip
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const {
      title,
      destination,
      country,
      coordinates,
      latitude,
      longitude,
      start_date,
      end_date,
      description,
      notes,
      tags,
      images,
      is_public,
      cover_image,
      cover_image_path,
      gallery_images
    } = req.body;

    // Handle coordinates from frontend (coordinates object takes priority)
    const finalLatitude = coordinates?.lat || latitude;
    const finalLongitude = coordinates?.lng || longitude;

    // Start transaction
    await db.query('BEGIN');

    try {
      // Update trip
      const result = await db.query(
        `UPDATE trips SET
          title = COALESCE($1, title),
          destination = COALESCE($2, destination),
          country = COALESCE($3, country),
          latitude = COALESCE($4, latitude),
          longitude = COALESCE($5, longitude),
          start_date = COALESCE($6, start_date),
          end_date = COALESCE($7, end_date),
          description = COALESCE($8, description),
          notes = COALESCE($9, notes),
          tags = COALESCE($10, tags),
          images = COALESCE($11, images),
          is_public = COALESCE($12, is_public),
          cover_image = COALESCE($13, cover_image),
          cover_image_path = COALESCE($14, cover_image_path),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $15 AND user_id = (
          SELECT id FROM users WHERE firebase_uid = $16
        )
        RETURNING *`,
        [
          title,
          destination,
          country,
          finalLatitude,
          finalLongitude,
          start_date,
          end_date,
          description,
          notes,
          tags,
          images,
          is_public,
          cover_image,
          cover_image_path,
          req.params.id,
          req.user.uid,
        ]
      );

      if (result.rows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: "Trip not found or unauthorized" });
      }

      const trip = result.rows[0];
      
      // Update gallery images if provided
      let galleryImagesData = [];
      if (gallery_images !== undefined) {
        // Delete existing gallery images
        await db.query(
          "DELETE FROM trip_gallery_images WHERE trip_id = $1",
          [trip.id]
        );
        
        // Add new gallery images
        if (Array.isArray(gallery_images)) {
          for (let i = 0; i < gallery_images.length; i++) {
            const image = gallery_images[i];
            const galleryResult = await db.query(
              `INSERT INTO trip_gallery_images (
                trip_id, url, path, filename, original_name, order_index
              ) VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING *`,
              [
                trip.id,
                image.url,
                image.path,
                image.filename,
                image.original_name || image.filename,
                image.order_index || i
              ]
            );
            galleryImagesData.push(galleryResult.rows[0]);
          }
        }
      } else {
        // If gallery_images not provided, fetch existing ones
        const existingGallery = await db.query(
          `SELECT id, url, path, filename, original_name, order_index, uploaded_at 
           FROM trip_gallery_images 
           WHERE trip_id = $1 
           ORDER BY order_index ASC, uploaded_at ASC`,
          [trip.id]
        );
        galleryImagesData = existingGallery.rows;
      }

      await db.query('COMMIT');
      
      // Return trip with coordinates and gallery images
      const tripWithData = {
        ...trip,
        coordinates: trip.latitude && trip.longitude ? {
          lat: parseFloat(trip.latitude),
          lng: parseFloat(trip.longitude)
        } : null,
        gallery_images: galleryImagesData
      };

      res.json(tripWithData);
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error("Error updating trip:", error);
    res.status(500).json({ error: "Failed to update trip" });
  }
});

// Add individual gallery image to trip
router.post("/:id/gallery", authenticateToken, async (req, res) => {
  try {
    const { url, path, filename, original_name, order_index } = req.body;
    
    if (!url || !path || !filename) {
      return res.status(400).json({ error: "URL, path, and filename are required" });
    }

    // Verify trip ownership
    const tripCheck = await db.query(
      `SELECT t.id FROM trips t 
       JOIN users u ON t.user_id = u.id 
       WHERE t.id = $1 AND u.firebase_uid = $2`,
      [req.params.id, req.user.uid]
    );

    if (tripCheck.rows.length === 0) {
      return res.status(404).json({ error: "Trip not found or unauthorized" });
    }

    const result = await db.query(
      `INSERT INTO trip_gallery_images (
        trip_id, url, path, filename, original_name, order_index
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        req.params.id,
        url,
        path,
        filename,
        original_name || filename,
        order_index || 0
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error adding gallery image:", error);
    res.status(500).json({ error: "Failed to add gallery image" });
  }
});

// Delete gallery image
router.delete("/:id/gallery/:imageId", authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM trip_gallery_images 
       WHERE id = $1 AND trip_id = $2 AND trip_id IN (
         SELECT t.id FROM trips t 
         JOIN users u ON t.user_id = u.id 
         WHERE u.firebase_uid = $3
       )
       RETURNING id`,
      [req.params.imageId, req.params.id, req.user.uid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Gallery image not found or unauthorized" });
    }

    res.json({ message: "Gallery image deleted successfully" });
  } catch (error) {
    console.error("Error deleting gallery image:", error);
    res.status(500).json({ error: "Failed to delete gallery image" });
  }
});

// Update gallery image order
router.put("/:id/gallery/:imageId/order", authenticateToken, async (req, res) => {
  try {
    const { order_index } = req.body;
    
    if (order_index === undefined) {
      return res.status(400).json({ error: "Order index is required" });
    }

    const result = await db.query(
      `UPDATE trip_gallery_images 
       SET order_index = $1 
       WHERE id = $2 AND trip_id = $3 AND trip_id IN (
         SELECT t.id FROM trips t 
         JOIN users u ON t.user_id = u.id 
         WHERE u.firebase_uid = $4
       )
       RETURNING *`,
      [order_index, req.params.imageId, req.params.id, req.user.uid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Gallery image not found or unauthorized" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating gallery image order:", error);
    res.status(500).json({ error: "Failed to update gallery image order" });
  }
});

// Delete trip
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM trips 
       WHERE id = $1 AND user_id = (
         SELECT id FROM users WHERE firebase_uid = $2
       )
       RETURNING id`,
      [req.params.id, req.user.uid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Trip not found or unauthorized" });
    }

    res.json({ message: "Trip deleted successfully" });
  } catch (error) {
    console.error("Error deleting trip:", error);
    res.status(500).json({ error: "Failed to delete trip" });
  }
});

// Add this after your existing routes, before module.exports

// Reverse geocoding endpoint to get country from coordinates
router.post("/reverse-geocode", authenticateToken, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    
    if (!latitude || !longitude) {
      return res.status(400).json({ error: "Latitude and longitude are required" });
    }

    // Using a free reverse geocoding service (you can replace with Google Maps API)
    const response = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`
    );
    
    if (!response.ok) {
      throw new Error('Reverse geocoding failed');
    }
    
    const data = await response.json();
    
    res.json({
      country: data.countryName || null,
      countryCode: data.countryCode || null,
      city: data.city || null,
      locality: data.locality || null
    });
  } catch (error) {
    console.error("Error in reverse geocoding:", error);
    res.status(500).json({ error: "Failed to get location details" });
  }
});

// Bulk update existing trips with country data
router.post("/update-countries", authenticateToken, async (req, res) => {
  try {
    // Get user ID
    const userResult = await db.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [req.user.uid]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userResult.rows[0].id;

    // Get trips without country data but with coordinates
    const tripsResult = await db.query(
      `SELECT id, latitude, longitude FROM trips 
       WHERE user_id = $1 AND country IS NULL 
       AND latitude IS NOT NULL AND longitude IS NOT NULL`,
      [userId]
    );

    const updatedTrips = [];
    
    for (const trip of tripsResult.rows) {
      try {
        // Reverse geocode each trip
        const response = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${trip.latitude}&longitude=${trip.longitude}&localityLanguage=en`
        );
        
        if (response.ok) {
          const data = await response.json();
          const country = data.countryName;
          
          if (country) {
            // Update trip with country
            await db.query(
              "UPDATE trips SET country = $1 WHERE id = $2",
              [country, trip.id]
            );
            updatedTrips.push({ id: trip.id, country });
          }
        }
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error updating trip ${trip.id}:`, error);
      }
    }

    res.json({
      message: `Updated ${updatedTrips.length} trips with country data`,
      updatedTrips
    });
  } catch (error) {
    console.error("Error updating countries:", error);
    res.status(500).json({ error: "Failed to update countries" });
  }
});

module.exports = router;

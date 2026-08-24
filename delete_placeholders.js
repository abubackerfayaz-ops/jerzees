require('dotenv').config();
const db = require('./database.js');

async function main() {
  await db.initialize();
  
  // Find jerseys where all images are base64 SVG placeholders
  const jerseys = await db.all(`
    SELECT j.id, j.name, 
           (SELECT COUNT(*) FROM jersey_images WHERE jersey_id = j.id) as total_images,
           (SELECT COUNT(*) FROM jersey_images WHERE jersey_id = j.id AND image_url LIKE 'data:image/svg+xml%') as placeholder_images
    FROM jerseys j
  `);
  
  const toDelete = jerseys.filter(j => j.total_images > 0 && j.total_images === j.placeholder_images);
  
  console.log(`Found ${toDelete.length} jerseys that only have placeholder images.`);
  
  if (toDelete.length > 0) {
    const ids = toDelete.map(j => j.id);
    
    // Postgres supports DELETE FROM jerseys WHERE id IN (1, 2, 3...)
    // Since variants, images are CASCADE deleted, we can just delete the jerseys
    // But what about cart items or order items? If there are any, we should probably just remove the jerseys.
    // Wait, order items don't have ON DELETE CASCADE for jerseys usually.
    // Let's just delete the cart items and order items manually if we need to.
    
    try {
      const variantIds = await db.all('SELECT id FROM variants WHERE jersey_id IN (' + ids.join(',') + ')');
      const vIds = variantIds.map(v => v.id);
      if (vIds.length > 0) {
        await db.query('DELETE FROM cart_items WHERE variant_id IN (' + vIds.join(',') + ')');
      }
      await db.query('DELETE FROM variants WHERE jersey_id IN (' + ids.join(',') + ')');
      await db.query('DELETE FROM jersey_images WHERE jersey_id IN (' + ids.join(',') + ')');
      await db.query('DELETE FROM jerseys WHERE id IN (' + ids.join(',') + ')');
      console.log('Successfully deleted ' + toDelete.length + ' jerseys without real images.');
    } catch (e) {
      console.error('Error deleting:', e.message);
    }
  }
}
main().catch(console.error);

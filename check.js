require('dotenv').config();
const db = require('./database.js');

async function main() {
  await db.initialize();
  
  // 1. Find Arsenal 23-24
  const j = await db.get("SELECT * FROM jerseys WHERE name ILIKE '%Arsenal 2023-24 Home%'");
  console.log('Jersey:', j);
  
  if (j) {
    const images = await db.all("SELECT * FROM jersey_images WHERE jersey_id = " + j.id);
    console.log('Images:', images);
  }

  // 2. See how many jerseys have broken image URLs (from Yupoo scraper we might have bad urls?)
  // Wait, how do I know if they are broken? 
  // Maybe they are valid URLs but they 404/403.
  
  // 3. Find any jerseys where all images are actually not loading or maybe the URL is literally placeholder?
  const badImages = await db.all("SELECT COUNT(*) FROM jersey_images WHERE image_url IS NULL OR image_url = '' OR image_url LIKE '%placeholder%'");
  console.log('Bad images:', badImages);
}
main().catch(console.error);

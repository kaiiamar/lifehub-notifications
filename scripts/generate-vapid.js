const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('Add these to your Vercel environment variables:\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\nAlso add: VAPID_EMAIL=mailto:[email]');

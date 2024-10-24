const Redis = require('ioredis');

let redisClient = null;
let redisEnabled = false;

function getRedisClient() {
  if (!redisEnabled) {
    return null;
  }

  if (!redisClient) {
    try {
      redisClient = new Redis({
        host: 'localhost',
        port: 6379,
        retryStrategy: (times) => {
          if (times > 3) {
            redisEnabled = false;
            console.log('Redis connection failed, disabled caching');
            return null;
          }
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3
      });

      redisClient.on('error', (err) => {
        console.error('Redis Client Error:', err);
        redisEnabled = false;
      });

      redisClient.on('connect', () => {
        console.log('Redis connected successfully');
        redisEnabled = true;
      });
    } catch (error) {
      console.error('Redis initialization error:', error);
      redisEnabled = false;
      return null;
    }
  }
  return redisClient;
}

async function cacheGet(key) {
  if (!redisEnabled || !redisClient) return null;
  try {
    return await redisClient.get(key);
  } catch (error) {
    console.error('Redis get error:', error);
    return null;
  }
}

async function cacheSet(key, value, ttl = 300) {
  if (!redisEnabled || !redisClient) return;
  try {
    await redisClient.setex(key, ttl, value);
  } catch (error) {
    console.error('Redis set error:', error);
  }
}

module.exports = {
  getRedisClient,
  cacheGet,
  cacheSet
};
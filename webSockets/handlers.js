const { processWithAI } = require('../services/aiService');
const { getRedisClient } = require('../services/redisService');

function setupWebSocketHandlers(wss) {
    wss.on('connection', (ws) => {
      console.log('New WebSocket connection established');
      let audioBuffer = [];
  
      ws.on('message', async (message) => {
        try {
          let parsedMessage;
          try {
            parsedMessage = JSON.parse(message);
          } catch (parseError) {
            throw new Error('Invalid message format');
          }
  
          const { type, payload } = parsedMessage;
  
          if (!type || !payload) {
            throw new Error('Message must include type and payload');
          }
  
          switch (type) {
            case 'transcript_analysis':
              if (!payload.text) {
                throw new Error('Transcript analysis requires text');
              }
              await handleTranscriptAnalysis(ws, payload);
              break;
  
            case 'audio_data':
              if (!(payload instanceof Buffer)) {
                throw new Error('Audio data must be a Buffer');
              }
              await handleAudioData(ws, payload, audioBuffer);
              break;
  
            default:
              console.warn('Unknown message type:', type);
              ws.send(JSON.stringify({
                type: 'error',
                payload: { message: 'Unknown message type' }
              }));
          }
        } catch (error) {
          console.error('WebSocket message handling error:', error);
          ws.send(JSON.stringify({
            type: 'error',
            payload: { 
              message: 'Failed to process message',
              details: error.message
            }
          }));
        }
      });
  
      ws.on('close', () => {
        console.log('WebSocket connection closed');
        audioBuffer = [];
      });
  
      // Send initial connection success message
      ws.send(JSON.stringify({
        type: 'connection_status',
        payload: { status: 'connected' }
      }));
    });
  }

  async function handleTranscriptAnalysis(ws, data) {
    const { text, context, fullTranscript } = data;
  
    try {
      const latestQuestion = extractLatestQuestion(text);
      const cacheKey = `analysis_${Buffer.from(latestQuestion || '').toString('base64')}`;
      const redis = getRedisClient();
  
      if (redis) {
        const cachedResponse = await redis.get(cacheKey);
        if (cachedResponse) {
          ws.send(JSON.stringify({
            type: 'analysis_response',
            payload: {
              content: JSON.parse(cachedResponse),
              fromCache: true
            }
          }));
          return;
        }
      }
  
      const stream = await processWithAI(text, context, fullTranscript, true);
      let fullResponse = '';
      
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullResponse += content;
        
        ws.send(JSON.stringify({
          type: 'analysis_stream',
          payload: {
            content,
            question: latestQuestion,
            isDone: false
          }
        }));
      }
  
      if (redis) {
        await redis.setex(cacheKey, 300, JSON.stringify({
          question: latestQuestion,
          answer: fullResponse,
          timestamp: new Date().toISOString()
        }));
      }
  
      // Send completion message
      ws.send(JSON.stringify({
        type: 'analysis_stream',
        payload: {
          content: '',
          isDone: true
        }
      }));
  
    } catch (error) {
      console.error('Analysis error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        payload: { message: 'Analysis failed', details: error.message }
      }));
    }
  }

async function handleAudioData(ws, audioData, audioBuffer) {
  audioBuffer.push(audioData);
  
  if (audioBuffer.length >= 10) {
    const audioChunk = Buffer.concat(audioBuffer);
    try {
      const transcript = await transcribeAudioChunk(audioChunk);
      ws.send(JSON.stringify({
        type: 'transcript',
        payload: transcript
      }));
    } catch (error) {
      console.error('Audio transcription error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        payload: { message: 'Transcription failed' }
      }));
    }
    audioBuffer.length = 0;
  }
}

module.exports = {
  setupWebSocketHandlers
};
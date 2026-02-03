# voiceagent-st-webhook

Node.js Express service that receives Retell `call_analyzed` webhooks, validates addresses with Google Maps, matches customers in ServiceTrade with fuzzy scoring, and creates jobs when confidence meets the threshold.

## Project Structure

```
src/
├── config/
│   ├── database.js          # Supabase configuration
│   └── environment.js       # Environment variables configuration
├── services/
│   ├── googleMapsService.js # Google Maps address validation
│   ├── customerMatchingService.js # Parallel matching + scoring
│   ├── retellService.js     # Retell API helper
│   ├── serviceTradeService.js # ServiceTrade API service
│   └── supabaseService.js   # Supabase database service
├── routes/
│   ├── webhook/
│   │   └── retell.js         # Retell webhook handler
│   └── serviceTrade/         # Existing ServiceTrade routes
├── middleware/
│   ├── logger.js            # Request logging middleware
│   └── errorHandler.js      # Error handling middleware
├── utils/
│   └── responseHelper.js    # Response utility functions
├── app.js                   # Express application setup
└── server.js                # Server startup file
```

## API Endpoints

### POST /webhook/retell
Handles Retell `call_analyzed` events, validates address, performs matching, and creates a job if confidence >= threshold.

### GET /health
Health check endpoint.

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
PORT=3000
NODE_ENV=development
SUPABASE_URL=your_supabase_url_here
SUPABASE_ANON_KEY=your_supabase_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
RETELL_API_KEY=your_retell_api_key_here
GOOGLE_MAPS_KEY=your_google_maps_key_here
MATCH_CONFIDENCE_THRESHOLD=80
FUZZY_SIMILARITY_THRESHOLD=0.8
```

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your environment variables

3. Start the development server:
```bash
npm run dev
```

4. Or start the production server:
```bash
npm start
```

## Scripts

- `npm start`: Start the production server
- `npm run dev`: Start the development server with nodemon

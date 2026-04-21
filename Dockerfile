# EQIS — Etrav QA Intelligence System
# Uses Microsoft's official Playwright image: Chromium + system deps + Node 20 pre-installed.
# This avoids the headache of installing Chromium dependencies manually on Railway/Render/Fly.

FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# Install ffmpeg for MP4 video conversion (sessionRecorder.js)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cached unless package.json changes)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Persistent state directories — Railway will mount a volume here.
# Without a volume, these are ephemeral (state lost on every redeploy).
RUN mkdir -p /app/state/fraka /app/reports/searchpulse /app/reports/journey /app/reports/recordings /app/reports/zipy /app/reports/fullbooking /app/logs

# Sensible production defaults for cloud deployment
ENV HEADLESS=true
ENV NODE_ENV=production
ENV DASHBOARD_ENABLED=true
ENV TIMEZONE=Asia/Kolkata

# Railway provides a dynamic PORT — Express should listen on it
EXPOSE 4000

CMD ["node", "eqis.js", "start"]

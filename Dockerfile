# 1. Use a lightweight Node.js image
FROM node:20-slim

# 2. Create app directory
WORKDIR /usr/src/app

# 3. Install app dependencies
# Copying package-lock.json for faster and consistent installs
COPY package*.json ./
RUN npm install --production

# 4. Bundle app source
COPY . .

# 5. Expose the port (Cloud Run uses PORT env var)
EXPOSE 8080

# 6. Start the server
CMD [ "node", "index.js" ]

# Deployment Guide: Firestore Database Studio & Backup

This guide provides step-by-step instructions for taking your Firestore Database Studio live using **Render** (for the full-stack app) and **Cloudflare Pages** (for frontend hosting).

---

## Architecture Overview

* **Frontend (`public/`)**: HTML, CSS, client-side JavaScript, and SVG icons.
* **Backend (`server.js`)**: Node.js Express server that interfaces with Google Firebase using the `firebase-admin` SDK, streams Firestore documents, reads/writes local backup files (`.jsonl`, `.csv`, `.enc`), and manages verification/restore workflows.

---

## Method 1: 1-Click Full-Stack Deployment on Render (Recommended)

> **Why Render?**  
> Render runs full-stack Node.js Express servers natively. It serves both the backend engine and the frontend UI together under a single live HTTPS URL for free.

### Step-by-Step Setup:

1. **Sign in to Render**:
   - Visit [render.com](https://render.com).
   - Click **Sign In** and choose **GitHub** (using your `ShubhTamrakar` account).

2. **Create a New Web Service**:
   - In your Render Dashboard, click **New +** at the top right and select **Web Service**.
   - Under **Connect a repository**, find and select `ShubhTamrakar/firestore-database-studio`.
   - *(If the repository does not appear, click "Configure GitHub App" to grant Render access to your repository).*

3. **Configure the Web Service**:
   Fill in the deployment parameters:
   * **Name**: `firestore-database-studio` (or your preferred name)
   * **Region**: Choose the region closest to you (e.g., Singapore, Frankfurt, Oregon)
   * **Branch**: `main`
   * **Root Directory**: *(leave blank)*
   * **Runtime**: `Node`
   * **Build Command**: `npm install`
   * **Start Command**: `node server.js`
   * **Instance Type**: Select **Free** ($0/month)

4. **Deploy**:
   - Scroll down and click **Create Web Service**.
   - Render will automatically clone the repository, install dependencies, and launch `node server.js`.
   - When the log displays `[REAL FIRESTORE BACKUP APP] Running at http://localhost:...`, your app is live!
   - Your live link will be shown at the top (e.g., `https://firestore-database-studio.onrender.com`).

---

## Method 2: Cloudflare Pages (Frontend) + Render (Backend API)

If you prefer hosting the user interface on Cloudflare's global edge network via **Cloudflare Pages**, you will deploy the frontend to Cloudflare Pages and the backend engine to Render.

### Part A: Deploy the Frontend to Cloudflare Pages

1. **Log in to Cloudflare**:
   - Open [dash.cloudflare.com](https://dash.cloudflare.com/).
2. **Create Pages Application**:
   - In the left sidebar, click **Compute (Workers & Pages)** > **Create application**.
   - Select the **Pages** tab and click **Connect to Git**.
3. **Select Repository**:
   - Authorize Cloudflare to access your GitHub account.
   - Select `ShubhTamrakar/firestore-database-studio` and click **Begin setup**.
4. **Configure Build Settings**:
   * **Project name**: `firestore-database-studio`
   * **Production branch**: `main`
   * **Framework preset**: `None`
   * **Build command**: *(leave blank)*
   * **Build output directory**: `public`
5. **Deploy**:
   - Click **Save and Deploy**.
   - Cloudflare Pages will serve your UI on a fast CDN URL (e.g. `https://firestore-database-studio.pages.dev`).

### Part B: Connect Cloudflare Pages to Your Render Backend

Because Cloudflare Pages only hosts static files, API calls (such as `/api/backup`, `/api/restore`, `/api/projects`) need to reach your running `server.js` on Render:

1. **Get Your Render Backend URL**:
   - Follow Method 1 above to deploy `server.js` on Render.
   - Copy your Render app URL (e.g., `https://firestore-database-studio.onrender.com`).
2. **Add a Redirect/Proxy Rule in Cloudflare**:
   - In your project's `public/` folder, a `_redirects` file can forward all `/api/*` calls to your Render backend:
     ```text
     /api/*  https://firestore-database-studio.onrender.com/api/:splat  200
     ```
   - This keeps your frontend on Cloudflare Pages while routing all backend calls to Render seamlessly with no CORS issues.

---

## Method 3: Cloudflare Tunnel (Keep Backups on Your PC & Access Remotely)

If you want the database backups stored directly on your physical computer while accessing the Studio securely from any browser or phone:

1. **Install Cloudflare Tunnel (`cloudflared`)**:
   - Download `cloudflared` for Windows from [developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. **Start Your Local Server**:
   ```bash
   node server.js
   ```
3. **Expose It to the Internet via Cloudflare**:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
4. Cloudflare will output a public HTTPS URL (e.g. `https://random-words.trycloudflare.com`). You can share this link or connect it to your own custom domain in Cloudflare.

---

## Security Notes

1. **Service Account Credentials**:
   - `.gitignore` is configured to never commit `.json` files or private keys to your public GitHub repository.
   - When deploying to Render, upload your service account files through the app's **Connect Databases** UI tab or store them securely.
2. **Repository URL**:
   - [https://github.com/ShubhTamrakar/firestore-database-studio](https://github.com/ShubhTamrakar/firestore-database-studio)

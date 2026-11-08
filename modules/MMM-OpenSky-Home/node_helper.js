/* MMM-OpenSky-Home node helper: the photo card.
 * - PHOTO_INIT {provider, folder, usb, url} → sets up the photo source (folder/USB by default, or Immich)
 * - PHOTO_NEXT → PHOTO {photos: [{id, date, place, portrait}]} | PHOTO_ERROR {message}
 * - GET /opensky-photo/<id> → the image (ids are opaque; file paths and Immich keys never reach the screen)
 */
const NodeHelper = require("node_helper");
const path = require("path");
const { osT } = require(path.join(__dirname, "..", "..", "lib", "client", "i18n.js"));   // texts in opensky.json's language
const lib = (f) => require(path.join(global.root_path, "modules", "opensky-lib", f));
const { createPhotoSource } = lib("photos.js");
const { secret } = lib("secrets.js");

module.exports = NodeHelper.create({
  start() {
    this.source = null;
    this.expressApp.get("/opensky-photo/:id", async (req, res) => {
      if (!this.source || !/^[A-Za-z0-9-]{8,64}$/.test(req.params.id)) return res.sendStatus(404);
      try {
        const img = await this.source.image(req.params.id);
        if (!img) return res.sendStatus(404);
        res.set("Content-Type", img.type);
        res.set("Cache-Control", "max-age=3600");
        res.send(img.body);
      } catch (e) {
        res.sendStatus(504);
      }
    });
  },

  async socketNotificationReceived(n, p) {
    if (n === "PHOTO_INIT") {
      this.settings = p || {};
      this.source = createPhotoSource(this.settings, secret);
    } else if (n === "PHOTO_NEXT") {
      if (!this.source) return this.sendSocketNotification("PHOTO_ERROR", { message: osT("Photos aren't set up") });
      try {
        this.sendSocketNotification("PHOTO", await this.source.next());
      } catch (e) {
        const folder = this.settings.provider === "immich" ? null : (this.settings.folder || "~/Pictures");
        const message = /no photos/.test(e.message) && folder
          ? (this.settings.usb !== false ? osT("Add photos to {folder} on the Pi, or a folder named OpenSky on a USB stick", { folder }) : osT("Add photos to {folder} on the Pi", { folder }))

          : e.message;
        this.sendSocketNotification("PHOTO_ERROR", { message });
      }
    }
  }
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Media types of the image formats that end up inside documents.
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

// -> the media type for an extension without its dot, or undefined.
const mimeOf = (ext) => MIME[ext];

module.exports = { mimeOf };

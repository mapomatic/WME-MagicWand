/* eslint-disable */
// ==UserScript==
// @name                WME MagicWand
// @namespace           http://en.advisor.travel/wme-magic-wand
// @description         The very same thing as same tool in graphic editor: select "similar" colored area and create landmark out of it
// @include             /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor.*$/
// @version             2.4
// @grant               none
// @require             https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js
// @require             https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.15.0/proj4.js
// @license             MIT
// @copyright           2018 Vadim Istratov <wpoi@ya.ru>
// ==/UserScript==

/**
// Special thanks goes to:
// https://github.com/AndriiHeonia/hull
// https://gist.github.com/tixxit/252222
// http://blog.cedric.ws/draw-the-convex-hull-with-canvas-and-javascript
// http://www.iis.sinica.edu.tw/page/jise/2012/201205_10.pdf
// http://stackoverflow.com/questions/849211/shortest-distance-between-a-point-and-a-line-segment?page=1&tab=active#tab-top
// http://jsfromhell.com/math/is-point-in-poly
// https://gist.github.com/robgaston/8855489
// https://github.com/predein
 */

/**
 * Contributors: justins83, MapOMatic (2023-?)
 */

/* global W */

import * as turf from "@turf/turf";
import type { Position } from "geojson";
import type { Venue, Selection, WmeSDK } from "wme-sdk-typings";
import proj4 from '@types/proj4';

let sdk: WmeSDK;
window.SDK_INITIALIZED.then(() => {
    if (!window.getWmeSdk) {
        throw new Error("SDK is not installed");
    }
    sdk = window.getWmeSdk({
        scriptId: "wme-magicwand",
        scriptName: "WME Magic Wand",
    });

    console.log(`SDK v ${sdk.getSDKVersion()} on ${sdk.getWMEVersion()} initialized`);
    sdk.Events.once({ eventName: "wme-ready" }).then(magicwand);
});

function magicwand() {

    const wmelmw_version = GM_info.script.version;

    window.wme_magic_wand_debug = false;
    window.wme_magic_wand_profile = false;

    window.wme_magicwand_helpers = {
        isDragging: false,
        draggedNode: null,
        modifiedFeatureControl: null,
        layer: null,
        snap: null,
    };

    /* helper function */
    function getElClass(classname: string, node) {
        if (!node) node = document.getElementsByTagName("body")[0];
        const a = [];
        const re = new RegExp(`\\b${classname}\\b`);
        const els = node.getElementsByTagName("*");
        for (let i = 0, j = els.length; i < j; i++) if (re.test(els[i].className)) a.push(els[i]);
        return a;
    }

    function getElId(node: string) : HTMLElement | null {
        return document.getElementById(node);
    }

    /* =========================================================================== */

    function initialiseMagicWand() {
        const userInfo = getElId("user-info");
        const userTabs = getElId("user-tabs");

        if (!getElClass("nav-tabs", userTabs)[0]) {
            setTimeout(initialiseMagicWand, 1000);
            return;
        }

        const navTabs = getElClass("nav-tabs", userTabs)[0];
        const tabContent = getElClass("tab-content", userInfo)[0];

        console.log("WME MagicWand init");

        window.wme_magic_wand = false;
        window.wme_magic_wand_process = false;

        // add new box to left of the map
        const addon = document.createElement("section");
        addon.innerHTML = `<b>WME Magic Wand</b> v${wmelmw_version}`;

        let section = document.createElement("p");
        section.style.paddingTop = "8px";
        section.style.textIndent = "16px";
        section.id = "magicwand_advanced";
        section.innerHTML =
            "<b>Advanced Editor Options</b><br/>" +
            '<label>Angle threshold<br/><input type="text" id="_cMagicWandAngleThreshold" name="_cMagicWandAngleThreshold" value="12" size="3" maxlength="2" /></label><br/>';
        addon.appendChild(section);

        section = document.createElement("p");
        section.style.paddingTop = "8px";
        section.style.textIndent = "16px";
        section.id = "magicwand_common";
        section.innerHTML =
            "<b>Magic wand tool</b><br/>" +
            '<input type="button" id="_bMagicWandProcessClick" name="_bMagicWandProcessClick" value="CLICK TO START MAGIC WAND" style="color: white; background-color: green" /><br/><br/>' +
            '<b>Status:</b> <span id="_sMagicWandStatus">Disabled</span><br/>' +
            '<b>Layer:</b> <span id="_sMagicWandUsedLayer"></span><br/>' +
            "<b>Clicked pixel color to match:</b>" +
            '<div id="_dMagicWandColorpicker" style="width: 20px; height: 20px; border: 1px solid black; display: inline-block; margin-left: 10px;">&nbsp;</div><br/>';

        addon.appendChild(section);

        section = document.createElement("p");
        section.style.paddingTop = "8px";
        section.style.textIndent = "16px";
        section.id = "magicwand_advanced";
        section.innerHTML =
            "<b>Options</b><br/>" +
            "Landmark type:<br/>" +
            '<select id="_sMagicWandLandmark" name="_sMagicWandLandmark" style="width: 95%"></select><br/><br/>' +
            "Color match algorithm:<br/>" +
            '<label><input type="radio" id="_rMagicWandColorAlgorithm_color" name="_rMagicWandColorAlgorithm" value="1" checked="checked" /> Color Distance</label><br/>' +
            '<label><input type="radio" id="_rMagicWandColorAlgorithm_lab" name="_rMagicWandColorAlgorithm" value="2" /> Human-eye Similarity</label><br/><br/>' +
            '<label for="_cMagicWandSimilarity">Tolerance</label><br/>Around 4-10, >20 very slow<br/>' +
            '<input type="text" id="_cMagicWandSimilarity" name="_cMagicWandSimilarity" value="8" size="4" maxlength="3" /><br/><br/>' +
            // + '<label for="_cMagicWandSimplification">Landmark simplification</label><br/>Usually 0-5, lesser gives more points in polygon<br/>'
            // + '<input type="text" id="_cMagicWandSimplification" name="_cMagicWandSimplification" value="3" size="5" maxlength="4" /><br/><br/>'
            '<label for="_cMagicWandSampling">Sampling mask size</label><br/>Usually 1-3, larger - smoother and more greedy<br/>' +
            '<input type="text" id="_cMagicWandSampling" name="_cMagicWandSampling" value="3" size="3" maxlength="1" /><br/>';
        addon.appendChild(section);

        const newtab = document.createElement("li");
        newtab.innerHTML = '<a href="#sidepanel-magicwand" data-toggle="tab">MagicWand</a>';
        navTabs.appendChild(newtab);

        addon.id = "sidepanel-magicwand";
        addon.className = "tab-pane";
        tabContent.appendChild(addon);

        populateLandmarks();
        loadWMEMagicWandSettings();

        // UI listeners
        $("#_bMagicWandProcessClick").click(switchMagicWandStatus);

        // Event listeners
        window.addEventListener("beforeunload", saveWMEMagicWandOptions, false);

        // Hotkeys
        registerKeyShortcut("WMEMagicWand_HighlightLandmark", "Highlight Landmarks", highlightLandmarks, {
            "C+k": "WMEMagicWand_HighlightLandmark",
        });

        // Start extension
        WMELandmarkMagicWand();
    }

    function loadWMEMagicWandSettings() {
        if (localStorage.WMEMagicWandScript) {
            console.log("WME MagicWand: loading options");
            const options = JSON.parse(localStorage.WMEMagicWandScript);

            for (let i = 0; i < getElId("_sMagicWandLandmark")?.options.length; i++) {
                if (getElId("_sMagicWandLandmark")?.options[i].value === options[2]) {
                    getElId("_sMagicWandLandmark")?.options[i].selected = true;
                    break;
                }
            }

            getElId("_cMagicWandSimilarity").value = typeof options[3] !== "undefined" ? options[3] : 9;
            // getElId('_cMagicWandSimplification').value = typeof options[4] !== 'undefined' ? options[4] : 4;
            getElId("_cMagicWandSampling").value = typeof options[5] !== "undefined" ? options[5] : 3;
            getElId("_cMagicWandAngleThreshold").value = typeof options[6] !== "undefined" ? options[6] : 12;
        }
    }

    function registerKeyShortcut(action_name, annotation, callback, key_map) {
        W.accelerators.addAction(action_name, { group: "default" });
        W.accelerators.events.register(action_name, null, callback);
        W.accelerators._registerShortcuts(key_map);
    }

    function saveWMEMagicWandOptions() {
        if (localStorage) {
            console.log("WME MagicWand: saving options");
            let options = [];

            // preserve previous options which may get lost after logout
            if (localStorage.WMEMagicWandScript) options = JSON.parse(localStorage.WMEMagicWandScript);

            options[2] = getElId("_sMagicWandLandmark").value;
            options[3] = getElId("_cMagicWandSimilarity").value;
            // options[4] = getElId('_cMagicWandSimplification').value;
            options[5] = getElId("_cMagicWandSampling").value;
            options[6] = getElId("_cMagicWandAngleThreshold").value;

            localStorage.WMEMagicWandScript = JSON.stringify(options);
        }
    }

    const highlightLandmarks = () => {
        if (!$("#_cMagicWandHighlight").prop("checked")) {
            return;
        }

        let geom;
        let components;
        let functor;
        let newWay;

        const venues: Venue[] = sdk.DataModel.Venues.getAll();
        // const venues = W.model.venues.getObjectArray();
        for (let i = 0; i < venues.length; i++) {
            const mark: Venue = venues[i];
            // const SelectedLandmark = W.model.venues.get(mark);
            if (mark.geometry.type === "Point") {
                continue;
            }

            // const poly = document.getElementById(SelectedLandmark.geometry.id);
            const editingSelection: Selection | null = sdk.Editing.getSelection();
            // check that WME hasn't highlighted this object already
            if (!editingSelection || mark.state === "Update" || editingSelection.objectType !== "venue" || mark.id !== editingSelection.ids[0]) {
                continue;
            }

            // if already highlighted by us or by WME Color Hightlight, avoid conflict and skip
            if (poly.getAttribute("stroke-opacity") === 0.987) {
                continue;
            }

            // if highlighted by mouse over, skip this one
            if (poly.getAttribute("fill") === poly.getAttribute("stroke")) {
                continue;
            }

            // flag this venue as highlighted so we don't update it next time
            poly.setAttribute("stroke-opacity", 0.987);

            geom = SelectedLandmark.geometry.clone();
            components = geom.components[0].components;
            functor = new OrthogonalizeId(components);

            newWay = functor.action();
            for (let j = 0; j < newWay.length; j++) {
                if (
                    newWay[j] === false ||
                    Math.abs(SelectedLandmark.geometry.components[0].components[j].x - newWay[j].x) > 2 ||
                    Math.abs(SelectedLandmark.geometry.components[0].components[j].y - newWay[j].y) > 2
                ) {
                    highlightAPlace(SelectedLandmark, "#FFC138", "#FFD38D");
                    break;
                }
            }
        }
    };

    // WME Color Highlights by Timbones
    function highlightAPlace(venue: Venue, fg: string, bg: string) {
        const poly = document.getElementById(venue.geometry.id);
        if (venue.isPoint()) {
            poly.setAttribute("fill", fg);
        } else {
            // area
            poly.setAttribute("stroke", fg);
            poly.setAttribute("fill", bg);
        }
    }

    class OrthogonalizeId {
        threshold = getElId("_cMagicWandAngleThreshold").value; // degrees within right or straight to alter
        lowerThreshold = Math.cos((90 - threshold) * (Math.PI / 180));
        upperThreshold = Math.cos(threshold * (Math.PI / 180));
        way: any;

        constructor(way) {
            this.way = way;
        };
        action() {
            const nodes = this.way;
            let points = nodes.slice(0, nodes.length - 1).map((n: MagicPoint) => {
                const t: MagicPoint = n.clone();
                const p = new MagicPoint(proj4("EPSG:900913", "EPSG:4326", t.toPosition()));
                p.y = lat2latp(p.y);
                return p;
            });
            const corner = { i: 0, dotp: 1 };
            const epsilon = 1e-4;
            let i;
            let j;
            let score;
            let motions;

            // Triangle
            if (nodes.length === 4) {
                for (i = 0; i < 1000; i++) {
                    motions = points.map(calcMotion);

                    const tmp = this.addPoints(points[corner.i], motions[corner.i]);
                    points[corner.i].x = tmp.x;
                    points[corner.i].y = tmp.y;

                    score = corner.dotp;
                    if (score < epsilon) {
                        break;
                    }
                }

                const n: MagicPoint = points[corner.i];
                n.y = latp2lat(n.y);
                const pp = proj4
                
                
                n.transform(
                    new OpenLayers.Projection("EPSG:4326"),
                    new OpenLayers.Projection("EPSG:900913")
                );

                const { id } = nodes[corner.i];
                for (i = 0; i < nodes.length; i++) {
                    if (nodes[i].id !== id) {
                        continue;
                    }

                    nodes[i].x = pp.x;
                    nodes[i].y = pp.y;
                }

                return nodes;
            }
            let best;
            const originalPoints = nodes.slice(0, nodes.length - 1).map((n) => {
                const t = n.clone();
                const p = t.transform(new OpenLayers.Projection("EPSG:900913"), new OpenLayers.Projection("EPSG:4326"));
                p.y = lat2latp(p.y);
                return p;
            });
            score = Infinity;

            for (i = 0; i < 1000; i++) {
                motions = points.map(calcMotion);
                for (j = 0; j < motions.length; j++) {
                    const tmp = addPoints(points[j], motions[j]);
                    points[j].x = tmp.x;
                    points[j].y = tmp.y;
                }
                const newScore = squareness(points);
                if (newScore < score) {
                    best = [].concat(points);
                    score = newScore;
                }
                if (score < epsilon) {
                    break;
                }
            }

            points = best;

            for (i = 0; i < points.length; i++) {
                // only move the points that actually moved
                if (originalPoints[i].x !== points[i].x || originalPoints[i].y !== points[i].y) {
                    const n = points[i];
                    n.y = latp2lat(n.y);
                    const pp = n.transform(
                        new OpenLayers.Projection("EPSG:4326"),
                        new OpenLayers.Projection("EPSG:900913")
                    );

                    const { id } = nodes[i];
                    for (j = 0; j < nodes.length; j++) {
                        if (nodes[j].id !== id) {
                            continue;
                        }

                        nodes[j].x = pp.x;
                        nodes[j].y = pp.y;
                    }
                }
            }

            // remove empty nodes on straight sections
            for (i = 0; i < points.length; i++) {
                const dotp = normalizedDotProduct(i, points);
                if (dotp < -1 + epsilon) {
                    const id = nodes[i].id;
                    for (j = 0; j < nodes.length; j++) {
                        if (nodes[j].id !== id) {
                            continue;
                        }

                        nodes[j] = false;
                    }
                }
            }

            return nodes;

            function calcMotion(b, k, array) {
                const a = array[(k - 1 + array.length) % array.length];
                const c = array[(k + 1) % array.length];
                let p = subtractPoints(a, b);
                let q = subtractPoints(c, b);

                const scale = 2 * Math.min(euclideanDistance(p, { x: 0, y: 0 }), euclideanDistance(q, { x: 0, y: 0 }));
                p = normalizePoint(p, 1.0);
                q = normalizePoint(q, 1.0);

                let dotp = filterDotProduct(p.x * q.x + p.y * q.y);

                // nasty hack to deal with almost-straight segments (angle is closer to 180 than to 90/270).
                if (array.length > 3) {
                    if (dotp < -0.707106781186547) {
                        dotp += 1.0;
                    }
                } else if (dotp && Math.abs(dotp) < corner.dotp) {
                    corner.i = k;
                    corner.dotp = Math.abs(dotp);
                }

                return normalizePoint(addPoints(p, q), 0.1 * dotp * scale);
            }
        };
        squareness(points) {
            return points.reduce((sum, val, i, array) => {
                let dotp = this.normalizedDotProduct(i, array);

                dotp = this.filterDotProduct(dotp);
                return sum + 2.0 * Math.min(Math.abs(dotp - 1.0), Math.min(Math.abs(dotp), Math.abs(dotp + 1)));
            }, 0);
        }

        normalizedDotProduct(i, points) {
            const a = points[(i - 1 + points.length) % points.length];
            const b = points[i];
            const c = points[(i + 1) % points.length];
            let p = this.subtractPoints(a, b);
            let q = this.subtractPoints(c, b);

            p = this.normalizePoint(p, 1.0);
            q = this.normalizePoint(q, 1.0);

            return p.x * q.x + p.y * q.y;
        }
        subtractPoints(a: MagicPoint, b: MagicPoint) {
            return { x: a.x - b.x, y: a.y - b.y };
        }
        addPoints(a: MagicPoint, b: MagicPoint) {
            return { x: a.x + b.x, y: a.y + b.y };
        }
        euclideanDistance(a: MagicPoint, b: MagicPoint) {
            const x = a.x - b.x;
            const y = a.y - b.y;
            return Math.sqrt(x * x + y * y);
        }
        normalizePoint(point: MagicPoint, scale: number) {
            const vector = { x: 0, y: 0 };
            const length = Math.sqrt(point.x * point.x + point.y * point.y);
            if (length !== 0) {
                vector.x = point.x / length;
                vector.y = point.y / length;
            }

            vector.x *= scale;
            vector.y *= scale;

            return vector;
        }
        filterDotProduct(dotp: number) {
            if (this.lowerThreshold > Math.abs(dotp) || Math.abs(dotp) > this.upperThreshold) {
                return dotp;
            }

            return 0;
        }
        isDisabled(nodes) {
            const points = nodes.slice(0, nodes.length - 1).map((n) => {
                const p = n
                    .toLonLat()
                    .transform(new OpenLayers.Projection("EPSG:900913"), new OpenLayers.Projection("EPSG:4326"));
                return { x: p.lat, y: p.lon };
            });

            return this.squareness(points);
        };
    };

    const switchMagicWandStatus = function () {
        window.wme_magic_wand = !window.wme_magic_wand;
        let bgColor;
        let status;
        let btnText;
        if (window.wme_magic_wand) {
            bgColor = "red";
            btnText = "CLICK TO STOP MAGIC WAND";
            status = "Waiting for click";
        } else {
            bgColor = "green";
            btnText = "CLICK TO START MAGIC WAND";
            status = "Disabled";
        }

        $(this).css("background-color", bgColor);
        $(this).val(btnText);
        updateStatus(status);
    };

    function updateStatus(status) {
        $("#_sMagicWandStatus").html(status);
        $("#magicwand_common").hide().show();
    }

    function populateLandmarks() {
        const landmarkTypes = getElId("_sMagicWandLandmark");
        const translations = window.I18n.translations[window.I18n.currentLocale()].venues.categories;

        let filteredTranslations = Object.keys(translations)
            .filter((id) => translations.hasOwnProperty(id))
            .map((id) => ({
                type_id: id,
                type_name: translations[id],
            }));

        // Sorting by name
        filteredTranslations = filteredTranslations.sort((a, b) => a.type_name.localeCompare(b.type_name));

        filteredTranslations.forEach((trans) => {
            const id = trans.type_id;
            const type = trans.type_name;

            const usrOption = document.createElement("option");
            const usrText = document.createTextNode(type);
            usrOption.setAttribute("value", id);
            usrOption.appendChild(usrText);
            landmarkTypes.appendChild(usrOption);
        });
    }

    function lat2latp(lat: number) {
        return (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + lat * (Math.PI / 180 / 2)));
    }

    function latp2lat(a: number) {
        return (180 / Math.PI) * (2 * Math.atan(Math.exp(a * (Math.PI / 180))) - Math.PI / 2);
    }

    function WMELandmarkMagicWand() {

        const MAX_CONCAVE_ANGLE_COS: number = Math.cos(90 / (180 / Math.PI)); // angle = 90 deg
        const MAX_SEARCH_BBOX_SIZE_PERCENT: number = 0.6;
        // const { W } = window;

        let layer;

        let LatLon;
        let pixel;

        let canvas;
        let draw_canvas;
        let total_tiles;
        let clickCanvasX: number;
        let clickCanvasY: number;
        let viewOffsetX;
        let viewOffsetY;
        let context;

        let color_sensitivity: number;
        let color_distance;
        let color_algorithm;
        let landmark_type;
        let sampling = 3;
        let waited_for = 0;
        let is_reload_tiles = true;

        sdk.Events.on({eventName: "wme-map-move-end", eventHandler: () => {
            is_reload_tiles = true;
        }});

        // W.map.events.register("changebaselayer", null, () => {
        //     is_reload_tiles = true;
        // });

        W.map.events.register("click", null, (e) => {
            if (!window.wme_magic_wand || window.wme_magic_wand_process) {
                return;
            }

            window.wme_magic_wand_process = true;
            $("#_bMagicWandProcessClick").attr("disabled", "disabled");

            // Get current active layer to process
            layer = null;

            const visible_layers = W.map.getLayersBy("visibility", true);
            for (let l = 0; l < visible_layers.length; l++) {
                if (visible_layers[l].name === "satellite_imagery") {
                    // (true === visible_layers[l].isBaseLayer) {
                    layer = visible_layers[l];

                    $("#_sMagicWandUsedLayer").html(layer.name);
                    break;
                }
            }

            if (typeof layer === "undefined") {
                resetProcessState();
                alert("Please make of the base layers active (default to Google)");
                return;
            }

            // simplify_param = parseInt(getElId('_cMagicWandSimplification').value, 10);
            color_sensitivity = parseInt(getElId("_cMagicWandSimilarity").value, 10);
            color_distance = parseInt(getElId("_cMagicWandSimilarity").value, 10);
            color_algorithm = getElId("_rMagicWandColorAlgorithm_lab").checked ? "LAB" : "sensitivity";
            landmark_type = getElId("_sMagicWandLandmark").options[getElId("_sMagicWandLandmark").selectedIndex].value;
            sampling = parseInt(getElId("_cMagicWandSampling").value, 10);

            pixel = e.xy;
            const geojsonLatLon = W.map.getLonLatFromPixel(pixel);
            const pt: GeoJSON.Point = {
                type: "Point",
                coordinates: [geojsonLatLon.lon, geojsonLatLon.lat],
            };
            const olLatLon = W.userscripts.toOLGeometry(pt);
            LatLon = { lon: olLatLon.x, lat: olLatLon.y };

            const tile_size = layer.grid[0][0].size;

            updateStatus("Creating canvas");

            if (typeof canvas !== "undefined" && typeof context !== "undefined") {
                if (is_reload_tiles) {
                    canvas.width = tile_size.h * layer.grid[0].length;
                    canvas.height = tile_size.w * layer.grid.length;
                    context.clearRect(0, 0, canvas.width, canvas.height);
                }
            } else {
                canvas = $("<canvas/>")[0];
                canvas.width = tile_size.h * layer.grid[0].length;
                canvas.height = tile_size.w * layer.grid.length;
                context = canvas.getContext("2d");
            }

            if (typeof draw_canvas === "undefined") {
                draw_canvas = $("<canvas/>")[0];
            }

            draw_canvas.width = canvas.width;
            draw_canvas.height = canvas.height;

            total_tiles = layer.grid.length * layer.grid[0].length;
            waited_for = 0;

            let clientX;
            let clientY;
            let offsetX;
            let offsetY;
            let imageX;
            let imageY;
            let tile;
            let img;
            let location;

            updateStatus("Pre-processing tiles");

            for (let tilerow = 0; tilerow < layer.grid.length; tilerow++) {
                for (let tilei = 0; tilei < layer.grid[tilerow].length; tilei++) {
                    tile = layer.grid[tilerow][tilei];

                    if (tile.bounds.containsLonLat(LatLon, false)) {
                        // Click position on div image
                        clientX = e.pageX;
                        clientY = e.pageY;

                        offsetX = $(tile.imgDiv).offset().left;
                        offsetY = $(tile.imgDiv).offset().top;

                        imageX = clientX - offsetX;
                        imageY = clientY - offsetY;

                        clickCanvasX = tile_size.w * tilei + imageX;
                        clickCanvasY = tile_size.h * tilerow + imageY;

                        viewOffsetX = pixel.x - clickCanvasX;
                        viewOffsetY = pixel.y - clickCanvasY;
                    }

                    // No need to reload tiles
                    if (
                        !is_reload_tiles &&
                        !($("img[data-default_url]").length > 0 && $("img[data-coords]").length > 0)
                    ) {
                        continue;
                    }

                    updateStatus("Loading tiles");

                    // Have to recreate image - image should have crossOrigin attribute set to "anonymous"
                    img = $("<img/>")[0];
                    $(img).data("tilei", tilei).data("tilerow", tilerow).attr("crossOrigin", "anonymous");

                    // eslint-disable-next-line no-loop-func
                    img.onload = function onload() {
                        const img1 = this;
                        const tilei1 = $(img1).data("tilei");
                        const tilerow1 = $(img1).data("tilerow");

                        // Add tile to canvas
                        context.drawImage(img1, tile_size.w * tilei1, tile_size.h * tilerow1, img1.width, img1.height);

                        total_tiles--;
                    };

                    img.onerror = function onerror(e1) {
                        console.log("WME MagicWand: Cannot load tile: ", e1);
                    };

                    let img_url = tile.url;
                    // Experimental support for Map Overlays extension
                    // DO NOT USE FOR EDITS
                    const alt_img = $(`img[data-default_url="${img_url}"]`);
                    if (alt_img.length > 0) {
                        img_url = alt_img[0].src;
                    }

                    location = getLocation(img_url);
                    img.src = `${img_url + (typeof location.search === "undefined" || location.search === "" ? "?" : "&")}dummy=wmemagicwand`;
                }
            }

            if (is_reload_tiles) {
                waitForLoad();
            } else {
                process();
            }
        });

        function waitForLoad() {
            waited_for++;
            if (total_tiles > 0) {
                if (waited_for > 25) {
                    alert(`Waiting too long for tiles to be reloaded, tiles left to load: ${total_tiles}`);
                    resetProcessState();
                    return;
                }

                window.setTimeout(waitForLoad, 200);
            } else {
                is_reload_tiles = false;
                process();
            }
        }

        function getPixelInfo(canvas_data, x, y) {
            const offset = (y * canvas.width + x) * 4;
            return [canvas_data[offset], canvas_data[offset + 1], canvas_data[offset + 2], canvas_data[offset + 3]];
        }

        function getPixelAverageSample(canvas_data, x, y) {
            let sample_info;
            const average = [0, 0, 0, 0];
            let total_samples = 0;
            for (let xi = x - sampling; xi < x + sampling; xi++) {
                for (let yi = y - sampling; yi < y + sampling; yi++) {
                    if (xi < 0 || yi < 0 || xi >= canvas.width || yi >= canvas.height) {
                        continue;
                    }

                    total_samples++;
                    sample_info = getPixelInfo(canvas_data, xi, yi);

                    average[0] += sample_info[0];
                    average[1] += sample_info[1];
                    average[2] += sample_info[2];
                    average[3] += sample_info[3];
                }
            }

            return [
                average[0] / total_samples,
                average[1] / total_samples,
                average[2] / total_samples,
                average[3] / total_samples,
            ];
        }

        function process() {
            let canvas_data = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const ref_pixel = getPixelInfo(canvas_data, clickCanvasX, clickCanvasY);

            const draw_canvas_context = draw_canvas.getContext("2d");
            draw_canvas_context.drawImage(canvas, 0, 0);

            $("#_dMagicWandColorpicker").css(
                "background-color",
                `rgb(${ref_pixel[0]},${ref_pixel[1]},${ref_pixel[2]})`
            );
            $("#magicwand_common").hide().show();

            let current_pixel;
            let processed_pixels = [];
            const polyPixels = [];
            let g = 0;
            let minX = Number.MAX_VALUE;
            let first_pixel = null;

            const stack: Position[] = [[clickCanvasX, clickCanvasY]];

            let x;
            let y;
            let c_pixel;
            let viewX;
            let viewY;

            updateStatus("Processing tiles image");

            const id = draw_canvas_context.createImageData(1, 1);
            const d = id.data;
            d[0] = 255;
            d[1] = 0;
            d[2] = 0;
            d[3] = 255; // red

            while (stack.length > 0 && g < 1500000) {
                g++;
                current_pixel = stack.pop();

                // Already processed before
                if (typeof processed_pixels[`${current_pixel[0]},${current_pixel[1]}`] !== "undefined") {
                    continue;
                } else {
                    processed_pixels[`${current_pixel[0]},${current_pixel[1]}`] = true;
                }

                if (current_pixel[0] < 0 || current_pixel[0] >= canvas.width) continue;
                if (current_pixel[1] < 0 || current_pixel[1] >= canvas.height) continue;

                x = current_pixel[0];
                y = current_pixel[1];
                c_pixel = getPixelAverageSample(canvas_data, x, y);

                if (
                    (color_algorithm === "sensitivity" && !colorDistance(c_pixel, ref_pixel)) ||
                    (color_algorithm === "LAB" && calcColorDistance(c_pixel, ref_pixel) > color_distance)
                ) {
                    viewX = x + viewOffsetX;
                    viewY = y + viewOffsetY;

                    if (viewX < minX) {
                        minX = viewX;
                        first_pixel = [viewX, viewY];
                    } else if (viewX === minX && viewY < first_pixel[1]) {
                        first_pixel = [viewX, viewY];
                    }

                    // Outer pixel found
                    polyPixels.push([viewX, viewY]);
                } else {
                    // Inner point, add neighboring points to the stack
                    if (typeof processed_pixels[`${current_pixel[0] - 1},${current_pixel[1]}`] === "undefined") {
                        stack.push([current_pixel[0] - 1, current_pixel[1]]);
                    }

                    if (typeof processed_pixels[`${current_pixel[0] + 1},${current_pixel[1]}`] === "undefined") {
                        stack.push([current_pixel[0] + 1, current_pixel[1]]);
                    }

                    if (typeof processed_pixels[`${current_pixel[0]},${current_pixel[1]}` - 1] === "undefined") {
                        stack.push([current_pixel[0], current_pixel[1] - 1]);
                    }

                    if (typeof processed_pixels[`${current_pixel[0]},${current_pixel[1]}${1}`] === "undefined") {
                        stack.push([current_pixel[0], current_pixel[1] + 1]);
                    }

                    // Experimental: with diagonal pixels
                    if (typeof processed_pixels[`${current_pixel[0] + 1},${current_pixel[1]}${1}`] === "undefined") {
                        stack.push([current_pixel[0], current_pixel[1] + 1]);
                    }
                    if (typeof processed_pixels[`${current_pixel[0] + 1},${current_pixel[1]}` - 1] === "undefined") {
                        stack.push([current_pixel[0], current_pixel[1] + 1]);
                    }
                    if (typeof processed_pixels[`${current_pixel[0] - 1},${current_pixel[1]}${1}`] === "undefined") {
                        stack.push([current_pixel[0], current_pixel[1] + 1]);
                    }
                    if (typeof processed_pixels[`${current_pixel[0] - 1},${current_pixel[1]}` - 1] === "undefined") {
                        stack.push([current_pixel[0], current_pixel[1] + 1]);
                    }
                }
            }

            // Clear unnecessary data
            processed_pixels = [];
            current_pixel = [];
            canvas_data = [];

            let points;

            if (polyPixels.length > 2) {
                updateStatus("Computing convex hull");

                points = [];
                for (let j = 0; j < polyPixels.length; j++) {
                    points.push(new MagicPoint(polyPixels[j][0], polyPixels[j][1]));
                }

                const convolutionHull = hull(points, 40, [".x", ".y"]);
                createLandmark(convolutionHull /* , simplify_param */);
            } else {
                points = [];
                resetProcessState("Please, try again, no useful points found");
                return;
            }

            points = [];
            resetProcessState();
        }

        function resetProcessState(status_msg: string | null = null) {
            status_msg = !status_msg ? "Waiting for click" : status_msg;

            window.wme_magic_wand_process = false;
            $("#_bMagicWandProcessClick").removeAttr("disabled");
            updateStatus(status_msg);
        }

        function colorDistance(c_pixel, ref_pixel) {
            return (
                Math.abs(c_pixel[0] - ref_pixel[0]) <= color_sensitivity &&
                Math.abs(c_pixel[1] - ref_pixel[1]) <= color_sensitivity &&
                Math.abs(c_pixel[2] - ref_pixel[2]) <= color_sensitivity &&
                Math.abs(c_pixel[3] - ref_pixel[3]) <= color_sensitivity
            );
        }

        function createLandmark(points /* , simplify */) {
            const polyPoints = [];
            let o;
            let point_lonlat;

            for (let k = 0; k < points.length; k++) {
                o = points[k];
                point_lonlat = W.map.getLonLatFromPixel(new OpenLayers.Pixel(o.x, o.y));
                polyPoints.push([point_lonlat.lon, point_lonlat.lat]);
            }

            // const LineString = new OpenLayers.Geometry.LineString(polyPoints);
            // if (simplify > 0) {
            //     LineString = LineString.simplify(simplify);
            // }
            window.turf = turf;
            const polygon = turf.polygon([polyPoints]).geometry;

            const WazefeatureVectorLandmark = require("Waze/Feature/Vector/Landmark");
            const WazeActionAddLandmark = require("Waze/Action/AddLandmark");

            const landmark = new WazefeatureVectorLandmark({ geoJSONGeometry: polygon });
            landmark.attributes.categories = [landmark_type];

            W.model.actionManager.add(new WazeActionAddLandmark(landmark));
        }

        //
        // Human-eye Similarity algorithm below
        //

        function calcColorDistance(c_pixel, r_pixel) {
            let xyz = rgbToXyz(c_pixel[0], c_pixel[1], c_pixel[2]);
            const lab = xyzToLab(xyz[0], xyz[1], xyz[2]);

            xyz = rgbToXyz(r_pixel[0], r_pixel[1], r_pixel[2]);
            const target_lab = xyzToLab(xyz[0], xyz[1], xyz[2]);

            return cie1994(lab, target_lab, false);

            //    return Math.sqrt(Math.pow(c_pixel[0] - r_pixel[0], 2) + Math.pow(c_pixel[1] - r_pixel[1], 2) + Math.pow(c_pixel[2] - r_pixel[2], 2));
        }

        // Convert RGB to XYZ
        function rgbToXyz(r, g, b) {
            let _r = r / 255;
            let _g = g / 255;
            let _b = b / 255;

            if (_r > 0.04045) {
                _r = ((_r + 0.055) / 1.055) ** 2.4;
            } else {
                _r /= 12.92;
            }

            if (_g > 0.04045) {
                _g = ((_g + 0.055) / 1.055) ** 2.4;
            } else {
                _g /= 12.92;
            }

            if (_b > 0.04045) {
                _b = ((_b + 0.055) / 1.055) ** 2.4;
            } else {
                _b /= 12.92;
            }

            _r *= 100;
            _g *= 100;
            _b *= 100;

            const X = _r * 0.4124 + _g * 0.3576 + _b * 0.1805;
            const Y = _r * 0.2126 + _g * 0.7152 + _b * 0.0722;
            const Z = _r * 0.0193 + _g * 0.1192 + _b * 0.9505;

            return [X, Y, Z];
        }

        // Convert XYZ to LAB
        function xyzToLab(x: number, y:number, z: number) {
            const ref_X = 95.047;
            const ref_Y = 100.0;
            const ref_Z = 108.883;

            let _X = x / ref_X;
            let _Y = y / ref_Y;
            let _Z = z / ref_Z;

            if (_X > 0.008856) {
                _X **= 1 / 3;
            } else {
                _X = 7.787 * _X + 16 / 116;
            }

            if (_Y > 0.008856) {
                _Y **= 1 / 3;
            } else {
                _Y = 7.787 * _Y + 16 / 116;
            }

            if (_Z > 0.008856) {
                _Z **= 1 / 3;
            } else {
                _Z = 7.787 * _Z + 16 / 116;
            }

            const CIE_L = 116 * _Y - 16;
            const CIE_a = 500 * (_X - _Y);
            const CIE_b = 200 * (_Y - _Z);

            return [CIE_L, CIE_a, CIE_b];
        }

        function getLocation(href: string): HTMLAnchorElement {
            const l: HTMLAnchorElement = document.createElement("a");
            l.href = href;
            return l;
        }

        // Finally, use cie1994 to get delta-e using LAB
        function cie1994(x, y, isTextiles) {
            x = { l: x[0], a: x[1], b: x[2] };
            y = { l: y[0], a: y[1], b: y[2] };
            let k2;
            let k1;
            let kl;
            const kh = 1;
            const kc = 1;
            if (isTextiles) {
                k2 = 0.014;
                k1 = 0.048;
                kl = 2;
            } else {
                k2 = 0.015;
                k1 = 0.045;
                kl = 1;
            }

            const c1 = Math.sqrt(x.a * x.a + x.b * x.b);
            const c2 = Math.sqrt(y.a * y.a + y.b * y.b);

            const sh = 1 + k2 * c1;
            const sc = 1 + k1 * c1;
            const sl = 1;

            const da = x.a - y.a;
            const db = x.b - y.b;
            const dc = c1 - c2;

            const dl = x.l - y.l;
            const dh = Math.sqrt(da * da + db * db - dc * dc);

            return Math.sqrt((dl / (kl * sl)) ** 2 + (dc / (kc * sc)) ** 2 + (dh / (kh * sh)) ** 2);
        }

        // intersect.js
        function ccw(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
            const cw = (y3 - y1) * (x2 - x1) - (y2 - y1) * (x3 - x1);
            return cw > 0 ? true : !(cw < 0); // colinear
        }

        function intersect(seg1, seg2) {
            const x1 = seg1[0][0];
            const y1 = seg1[0][1];
            const x2 = seg1[1][0];
            const y2 = seg1[1][1];
            const x3 = seg2[0][0];
            const y3 = seg2[0][1];
            const x4 = seg2[1][0];
            const y4 = seg2[1][1];

            return (
                ccw(x1, y1, x3, y3, x4, y4) !== ccw(x2, y2, x3, y3, x4, y4) &&
                ccw(x1, y1, x2, y2, x3, y3) !== ccw(x1, y1, x2, y2, x4, y4)
            );
        }

        // grid.js
        function Grid(points, cellSize) {
            this._cells = [];
            this._cellSize = cellSize;

            points.forEach(function gridPoint(point) {
                const cellXY = this.point2CellXY(point);
                const x = cellXY[0];
                const y = cellXY[1];
                if (this._cells[x] === undefined) {
                    this._cells[x] = [];
                }
                if (this._cells[x][y] === undefined) {
                    this._cells[x][y] = [];
                }
                this._cells[x][y].push(point);
            }, this);
        }

        Grid.prototype = {
            cellPoints(x: string | number, y: string | number) {
                // (Number, Number) -> Array
                return this._cells[x] !== undefined && this._cells[x][y] !== undefined ? this._cells[x][y] : [];
            },

            rangePoints(bbox:GeoJSON.BBox) {
                // (Array) -> Array
                const tlCellXY = this.point2CellXY([bbox[0], bbox[1]]);
                const brCellXY = this.point2CellXY([bbox[2], bbox[3]]);
                let points:  = [];

                for (let x = tlCellXY[0]; x <= brCellXY[0]; x++) {
                    for (let y = tlCellXY[1]; y <= brCellXY[1]; y++) {
                        points = points.concat(this.cellPoints(x, y));
                    }
                }

                return points;
            },

            removePoint(point) {
                // (Array) -> Array
                const cellXY = this.point2CellXY(point);
                const cell = this._cells[cellXY[0]][cellXY[1]];
                let pointIdxInCell;

                for (let i = 0; i < cell.length; i++) {
                    if (cell[i][0] === point[0] && cell[i][1] === point[1]) {
                        pointIdxInCell = i;
                        break;
                    }
                }

                cell.splice(pointIdxInCell, 1);

                return cell;
            },

            point2CellXY(point) {
                // (Array) -> Array
                const x = parseInt(point[0] / this._cellSize, 10);
                const y = parseInt(point[1] / this._cellSize, 10);
                return [x, y];
            },

            extendBbox(bbox, scaleFactor) {
                // (Array, Number) -> Array
                return [
                    bbox[0] - scaleFactor * this._cellSize,
                    bbox[1] - scaleFactor * this._cellSize,
                    bbox[2] + scaleFactor * this._cellSize,
                    bbox[3] + scaleFactor * this._cellSize,
                ];
            },
        };

        function grid(points, cellSize) {
            return new Grid(points, cellSize);
        }

        // format.js
        const formatUtil = {
            toXy(pointset, format) {
                if (format === undefined) {
                    return pointset.slice();
                }
                return pointset.map((pt) => [pt.x, pt.y]);
            },

            fromXy(pointset, format) {
                if (format === undefined) {
                    return pointset.slice();
                }
                return pointset.map((pt) => ({ x: pt[0], y: pt[1] }));
            },
        };

        // convex.js
        function _cross(o, a, b) {
            return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        }

        function _upperTangent(pointset) {
            const lower = [];
            for (let l = 0; l < pointset.length; l++) {
                while (
                    lower.length >= 2 &&
                    _cross(lower[lower.length - 2], lower[lower.length - 1], pointset[l]) <= 0
                ) {
                    lower.pop();
                }
                lower.push(pointset[l]);
            }
            lower.pop();
            return lower;
        }

        function _lowerTangent(pointset) {
            const reversed = pointset.reverse();
            const upper = [];
            for (let u = 0; u < reversed.length; u++) {
                while (
                    upper.length >= 2 &&
                    _cross(upper[upper.length - 2], upper[upper.length - 1], reversed[u]) <= 0
                ) {
                    upper.pop();
                }
                upper.push(reversed[u]);
            }
            upper.pop();
            return upper;
        }

        // pointset has to be sorted by X
        function convex(pointset) {
            const upper = _upperTangent(pointset);
            const lower = _lowerTangent(pointset);
            const result = lower.concat(upper);
            result.push(pointset[0]);
            return result;
        }

        // hull.js

        function _filterDuplicates(pointset) {
            return pointset.filter((el, idx, arr) => {
                const prevEl = arr[idx - 1];
                return idx === 0 || !(prevEl[0] === el[0] && prevEl[1] === el[1]);
            });
        }

        function _sortByX(pointset) {
            return pointset.sort((a, b) => {
                if (a[0] === b[0]) {
                    return a[1] - b[1];
                }
                return a[0] - b[0];
            });
        }

        function _sqLength(a: number[], b: number[]) {
            return (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
        }

        function _cos(o, a, b) {
            const aShifted = [a[0] - o[0], a[1] - o[1]];
            const bShifted = [b[0] - o[0], b[1] - o[1]];
            const sqALen = _sqLength(o, a);
            const sqBLen = _sqLength(o, b);
            const dot = aShifted[0] * bShifted[0] + aShifted[1] * bShifted[1];

            return dot / Math.sqrt(sqALen * sqBLen);
        }

        function _intersect(segment, pointset) {
            for (let i = 0; i < pointset.length - 1; i++) {
                const seg = [pointset[i], pointset[i + 1]];
                if (
                    (segment[0][0] === seg[0][0] && segment[0][1] === seg[0][1]) ||
                    (segment[0][0] === seg[1][0] && segment[0][1] === seg[1][1])
                ) {
                    continue;
                }
                if (intersect(segment, seg)) {
                    return true;
                }
            }
            return false;
        }

        function _occupiedArea(pointset) {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (let i = pointset.length - 1; i >= 0; i--) {
                if (pointset[i][0] < minX) {
                    minX = pointset[i][0];
                }
                if (pointset[i][1] < minY) {
                    minY = pointset[i][1];
                }
                if (pointset[i][0] > maxX) {
                    maxX = pointset[i][0];
                }
                if (pointset[i][1] > maxY) {
                    maxY = pointset[i][1];
                }
            }

            return [
                maxX - minX, // width
                maxY - minY, // height
            ];
        }

        function _bBoxAround(edge) {
            return [
                Math.min(edge[0][0], edge[1][0]), // left
                Math.min(edge[0][1], edge[1][1]), // top
                Math.max(edge[0][0], edge[1][0]), // right
                Math.max(edge[0][1], edge[1][1]), // bottom
            ];
        }

        // let MAX_CONCAVE_ANGLE_COS; // angle = 90 deg
        // let MAX_SEARCH_BBOX_SIZE_PERCENT;
        function _midPoint(edge, innerPoints, convex1) {
            let point = null;
            let angle1Cos = MAX_CONCAVE_ANGLE_COS;
            let angle2Cos = MAX_CONCAVE_ANGLE_COS;
            let a1Cos;
            let a2Cos;

            for (let i = 0; i < innerPoints.length; i++) {
                a1Cos = _cos(edge[0], edge[1], innerPoints[i]);
                a2Cos = _cos(edge[1], edge[0], innerPoints[i]);

                if (
                    a1Cos > angle1Cos &&
                    a2Cos > angle2Cos &&
                    !_intersect([edge[0], innerPoints[i]], convex1) &&
                    !_intersect([edge[1], innerPoints[i]], convex1)
                ) {
                    angle1Cos = a1Cos;
                    angle2Cos = a2Cos;
                    point = innerPoints[i];
                }
            }

            return point;
        }

        function _concave(convex1, maxSqEdgeLen, maxSearchArea, grid1, edgeSkipList) {
            let edge;
            let keyInSkipList;
            let scaleFactor;
            let midPoint;
            let bBoxAround;
            let bBoxWidth;
            let bBoxHeight;
            let midPointInserted = false;

            for (let i = 0; i < convex1.length - 1; i++) {
                edge = [convex1[i], convex1[i + 1]];
                keyInSkipList = `${edge[0].join()},${edge[1].join()}`;

                if (_sqLength(edge[0], edge[1]) < maxSqEdgeLen || edgeSkipList[keyInSkipList] === true) {
                    continue;
                }

                scaleFactor = 0;
                bBoxAround = _bBoxAround(edge);
                do {
                    bBoxAround = grid1.extendBbox(bBoxAround, scaleFactor);
                    bBoxWidth = bBoxAround[2] - bBoxAround[0];
                    bBoxHeight = bBoxAround[3] - bBoxAround[1];

                    midPoint = _midPoint(edge, grid1.rangePoints(bBoxAround), convex1);
                    scaleFactor++;
                } while (midPoint === null && (maxSearchArea[0] > bBoxWidth || maxSearchArea[1] > bBoxHeight));

                if (bBoxWidth >= maxSearchArea[0] && bBoxHeight >= maxSearchArea[1]) {
                    edgeSkipList[keyInSkipList] = true;
                }

                if (midPoint !== null) {
                    convex1.splice(i + 1, 0, midPoint);
                    grid1.removePoint(midPoint);
                    midPointInserted = true;
                }
            }

            if (midPointInserted) {
                return _concave(convex1, maxSqEdgeLen, maxSearchArea, grid1, edgeSkipList);
            }

            return convex1;
        }

        function hull(pointset, concavity, format) {
            const maxEdgeLen = concavity || 20;

            if (pointset.length < 4) {
                return pointset.slice();
            }

            const points = _filterDuplicates(_sortByX(formatUtil.toXy(pointset, format)));

            const occupiedArea = _occupiedArea(points);
            const maxSearchArea = [
                occupiedArea[0] * MAX_SEARCH_BBOX_SIZE_PERCENT,
                occupiedArea[1] * MAX_SEARCH_BBOX_SIZE_PERCENT,
            ];

            const convex1 = convex(points);
            const innerPoints = points.filter((pt) => convex1.indexOf(pt) < 0);

            const cellSize = Math.ceil(1 / (points.length / (occupiedArea[0] * occupiedArea[1])));

            const concave = _concave(convex1, maxEdgeLen ** 2, maxSearchArea, grid(innerPoints, cellSize), {});

            return formatUtil.fromXy(concave, format);
        }
    }


    // Point class
    class MagicPoint {
        x: number;
        y: number;
        static distance(pt1: MagicPoint, pt2: MagicPoint) {
            return pt1.distance(pt2);
        };
        static interpolate(pt1: MagicPoint, pt2: MagicPoint, f: number) {
            return pt1.interpolate(pt2, f);
        };
        constructor(position: number[]) {
            if(position.length !== 2) {
                throw new Error("Logic Error.  Position has to have just X and Y Coordinates");
            }
            this.x = position[0];
            this.y = position[1];
        }
        toString() {
            return `(x=${this.x}, y=${this.y})`;
        }
        rotateRight(p1: MagicPoint, p2: MagicPoint): boolean {
            // cross product, + is counterclockwise, - is clockwise
            return p2.x * this.y - p2.y * this.x - (p1.x * this.y - p1.y * this.x) + (p1.x * p2.y - p1.y * p2.x) < 0;
        };
        add(v: MagicPoint) {
            return new MagicPoint([this.x + v.x, this.y + v.y]);
        };
        clone() {return new MagicPoint([this.x, this.y]);    };
        degreesTo(v: MagicPoint) {
            const dx = this.x - v.x;
            const dy = this.y - v.y;
            const angle = Math.atan2(dy, dx); // radians
            return angle * (180 / Math.PI); // degrees
        };
        distance(v: MagicPoint) {
            const x = this.x - v.x;
            const y = this.y - v.y;
            return Math.sqrt(x * x + y * y);
        };
        equals(toCompare: MagicPoint) {
            return this.x === toCompare.x && this.y === toCompare.y;
        };
        interpolate(v: MagicPoint, f: number) {
            return new MagicPoint([(this.x + v.x) * f, (this.y + v.y) * f]);
        };

        length() {
            return Math.sqrt(this.x * this.x + this.y * this.y);
        };
        normalize(thickness: number) {
            const l = this.length();
            this.x = (this.x / l) * thickness;
            this.y = (this.y / l) * thickness;
        };
        orbit(origin: MagicPoint, arcWidth: number, arcHeight: number, degrees: number) {
            const radians = degrees * (Math.PI / 180);
            this.x = origin.x + arcWidth * Math.cos(radians);
            this.y = origin.y + arcHeight * Math.sin(radians);
        };
        offset(dx: number, dy: number) {
            this.x += dx;
            this.y += dy;
        };
        subtract(v: MagicPoint) {
            return new MagicPoint([this.x - v.x, this.y - v.y]);
        };
        polar(len: number, angle: number) {
            return new MagicPoint([len * Math.cos(angle), len * Math.sin(angle)]);
        };
        toPosition(): GeoJSON.Position {
            return [this.x, this.y];
        }
    }

    initialiseMagicWand();
}

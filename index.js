// noinspection JSUnresolvedReference

import { writeFile } from 'node:fs/promises'
import { writable } from 'simple-store-svelte'
import AnimeResolver from './utils/animeresolver.js'

import fs from 'fs'
import path from 'path'

const BEARER_TOKEN = process.env.ANIMESCHEDULE_TOKEN
if (!BEARER_TOKEN) {
    console.error('Error: ANIMESCHEDULE_TOKEN environment variable is not defined.')
    process.exit(1)
}

const currentTime = Math.floor(Date.now() / 1000)

// Fetch airing lists //

let airingLists = writable()

console.log(`Getting dub airing schedule`)
let res = {}
try {
    res = await fetch('https://animeschedule.net/api/v3/timetables/dub', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${BEARER_TOKEN}`
        }
    })
} catch (e) {
    if (!res || res.status !== 404) throw e
}
if (!res.ok && (res.status === 429 || res.status === 500)) {
    throw res
}
let json = null
try {
    json = await res.json()
} catch (error) {
    if (res.ok) console.log(`Error: ${error.status || 429} - ${error.message}`)
}
if (!res.ok) {
    if (json) {
        for (const error of json?.errors || []) {
            console.log(`Error: ${error.status || 429} - ${error.message}`)
        }
    } else {
        console.log(`Error: ${res.status || 429} - ${res.message}`)
    }
}
airingLists.value = await json

if (await airingLists.value) {
    console.log(`Successfully retrieved ${airingLists.value.length} airing, saving...`)
    airingLists.value.sort((a, b) => a.title.localeCompare(b.title))
    await writeFile('dub-schedule.json', JSON.stringify(airingLists.value))
    await writeFile('dub-schedule-readable.json', JSON.stringify(airingLists.value, null, 2))
} else {
    console.error('Error: Failed to fetch the dub airing schedule, it cannot be null!')
    process.exit(1)
}

// end of airing lists //

// resolve airing lists //

const airing = await airingLists.value
const titles = []
const order = []

// Resolve routes as titles
const parseObjs = await AnimeResolver.findAndCacheTitle(airing.map(item => item.route))

for (const parseObj of parseObjs) {
    const media = AnimeResolver.animeNameCache[AnimeResolver.getCacheKeyForTitle(parseObj)]
    console.log(`Resolving route ${parseObj?.anime_title} ${media?.title?.userPreferred}`)
    let item

    if (!media) { // Resolve failed routes
        console.log(`Failed to resolve, trying alternative title ${parseObj?.anime_title}`)
        item = airing.find(i => i.route === parseObj.anime_title)
        const fallbackTitles = await AnimeResolver.findAndCacheTitle([item.romaji, item.native, item.english, item.title].filter(Boolean))
        for (const parseObjAlt of fallbackTitles) {
            const mediaAlt = AnimeResolver.animeNameCache[AnimeResolver.getCacheKeyForTitle(parseObjAlt)]
            if (mediaAlt) {
                titles.push(parseObjAlt.anime_title)
                order.push({ route: item.route, title: mediaAlt.title.userPreferred })
                console.log(`Resolved alternative title ${parseObjAlt?.anime_title} ${mediaAlt?.title?.userPreferred}`)
                break
            }
        }
    } else {
        item = airing.find(i => i.route === parseObj.anime_title)
        if (item) {
            titles.push(parseObj.anime_title)
            order.push({ route: item.route, title: media.title.userPreferred })
            console.log(`Resolved route ${parseObj?.anime_title} ${media?.title?.userPreferred}`)
        }
    }
}

/**
 * @param {Date} episodeDate
 * @param {number} weeks - the number of weeks past the episodeDate
 * @param {boolean} skip - Add the specified number of weeks regardless of the episodeDate having past.
 * @returns {Date}
 */
function past(episodeDate, weeks = 0, skip) {
    if (episodeDate < new Date() || skip) {
        episodeDate.setDate(episodeDate.getDate() + (7 * weeks))
    }
    return episodeDate
}

// Resolve found titles
const results = await AnimeResolver.resolveFileAnime(titles)
for (const entry of order) { // remap dub airingSchedule to results airingSchedule
    const mediaMatch = results.find(result => result.media?.title?.userPreferred === entry.title)
    if (mediaMatch) {
        const airingItem = airing.find(i => i.route === entry.route)
        if (airingItem) {
            console.log(`Mapping dubbed airing schedule for ${airingItem.route} ${mediaMatch.media?.title?.userPreferred}`)
            mediaMatch.media.airingSchedule = {
                nodes: [
                    {
                        episode: airingItem.episodeNumber + ((new Date(airingItem.episodeDate) < new Date()) ? 1 : 0),
                        airingAt: Math.floor(past(new Date(airingItem.episodeDate), 1, false).getTime() / 1000),
                        episodeNumber: airingItem.episodeNumber,
                        episodeDate: airingItem.episodeDate,
                        delayedUntil: airingItem.delayedUntil,
                        unaired: (airingItem.episodeNumber <= 1 && Math.floor(new Date(airingItem.episodeDate).getTime() / 1000) > currentTime)
                    },
                ],
            }
        }
    }
}

if (results) {
    console.log(`Successfully resolved ${results.length} airing, saving...`)
    await writeFile('dub-schedule-resolved.json', JSON.stringify(results))
    await writeFile('dub-schedule-resolved-readable.json', JSON.stringify(results, null, 2))
} else {
    console.error('Error: Failed to resolve the dub airing schedule, it cannot be null!')
    process.exit(1)
}

console.log(`Finished fetching dub airing schedule.`)

// end of resolve airing lists //

// update dub schedule feed //

const scheduleFilePath = path.join(__dirname, 'dub-schedule-resolved.json')
const feedFilePath = path.join(__dirname, 'dub-episode-feed.json')

function loadJSON(filePath) {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify([]))
    return JSON.parse(fs.readFileSync(filePath))
}

function saveJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data))
}

const schedule = loadJSON(scheduleFilePath)
const existingFeed = loadJSON(feedFilePath)

const newEpisodes = schedule.map(entry =>
    {
        const airing = entry.media.airingSchedule.nodes[0]
        return {
            id: entry.media.id,
            idMal: entry.media.idMal,
            episode: {
                ...(airing.unaired && { unaired: airing.unaired }),
                aired: airing.episodeNumber,
                airedAt: (new Date(airing.episodeDate).getTime() / 1000),
                airedUTC: airing.episodeDate,
            }
        }
    }).filter(({ id, episode}) => { return !existingFeed.some(media => media.id === id && media.episode.aired === episode.aired) && !episode.unaired && episode.airedAt <= currentTime }).sort((a, b) => b.episode.airedAt - a.episode.airedAt)

saveJSON(feedFilePath, [...newEpisodes, ...existingFeed])

console.log(`Logged a total of ${newEpisodes.length + existingFeed.length} Dubbed Episodes to date.`)
console.log(`Added ${newEpisodes.length} new episodes to the Dubbed Episodes Feed.`)

// end update dub schedule feed //

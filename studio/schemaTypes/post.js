import {defineArrayMember, defineField, defineType} from 'sanity'
import {DocumentTextIcon} from '@sanity/icons/DocumentText'
import {BulbOutlineIcon} from '@sanity/icons/BulbOutline'
import {PlayIcon} from '@sanity/icons/Play'
import {ImagesIcon} from '@sanity/icons/Images'
import {VideoIcon} from '@sanity/icons/Video'
import {CategorySelect} from './CategorySelect'
import {VideoLinkInput, videoLinkError, videoPreview} from './VideoLinkInput'

// Image upload with alt text, grouped under "Images" in the form
const imageField = ({name, title, description}) =>
  defineField({
    name,
    title,
    type: 'image',
    fieldset: 'images',
    description,
    options: {hotspot: true},
    fields: [
      defineField({
        name: 'alt',
        title: 'Alt text',
        type: 'string',
        description: 'Describe the image for screen readers and Google.',
      }),
    ],
  })

export default defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  icon: DocumentTextIcon,
  fieldsets: [
    {
      name: 'images',
      title: 'Images',
      description: 'Click the crop icon on each image to set the hotspot, so the subject stays in view when cropped.',
    },
    {
      name: 'noImage',
      title: 'Cover when there is no image',
      description: 'Only used if no images are uploaded above.',
      options: {collapsible: true, collapsed: true},
    },
  ],
  fields: [
    defineField({
      name: 'title',
      type: 'string',
      validation: (r) => r.required().max(110),
    }),
    defineField({
      name: 'slug',
      type: 'slug',
      description: 'The web address of the post. Click "Generate".',
      options: {source: 'title', maxLength: 96},
      validation: (r) =>
        r.required().custom((slug) =>
          !slug?.current || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.current)
            ? true
            : 'Use only lowercase letters, numbers and single hyphens, with no spaces (e.g. "sue-chef-kitchen"). Click "Generate" to fix it.',
        ),
    }),
    imageField({
      name: 'mainImage',
      title: 'Card image',
      description:
        'Shown on the blog home (cards and the large featured slot). Upload 1200 × 750 px (16:10). Also used as the phone banner if none is uploaded below.',
    }),
    imageField({
      name: 'articleImage',
      title: 'Article banner – desktop',
      description:
        'The wide banner at the top of the article on computers and tablets. Upload 1800 × 771 px (21:9). If empty, the card image is used.',
    }),
    imageField({
      name: 'articleImageMobile',
      title: 'Article banner – phone',
      description:
        'The banner at the top of the article on phones. Upload 1200 × 750 px (16:10, same shape as the cards). If empty, the card image is used.',
    }),
    defineField({
      name: 'excerpt',
      title: 'Summary',
      type: 'text',
      rows: 3,
      description: 'One or two sentences. Shown on cards, under the title and in search results.',
      validation: (r) => r.required().max(220),
    }),
    defineField({
      name: 'category',
      type: 'reference',
      to: [{type: 'category'}],
      description: 'Pick an existing category. New ones are added under Categories.',
      // Pick-only dropdown: no "Create new" button in the post form
      options: {disableNew: true},
      components: {input: CategorySelect},
      validation: (r) => r.required(),
    }),
    defineField({name: 'author', type: 'reference', to: [{type: 'author'}]}),
    defineField({
      name: 'publishedAt',
      title: 'Publish date',
      type: 'datetime',
      initialValue: () => new Date().toISOString(),
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'featured',
      title: 'Feature on blog home',
      type: 'boolean',
      description: 'Shows this post in the large slot at the top. If several are ticked, the newest wins.',
      initialValue: false,
    }),
    defineField({
      name: 'body',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'block',
          styles: [
            {title: 'Normal', value: 'normal'},
            {title: 'Heading', value: 'h2'},
            {title: 'Subheading', value: 'h3'},
            {title: 'Quote', value: 'blockquote'},
          ],
          marks: {
            decorators: [
              {title: 'Bold', value: 'strong'},
              {title: 'Italic', value: 'em'},
              {title: 'Code', value: 'code'},
            ],
          },
        }),
        defineArrayMember({
          type: 'image',
          title: 'Image',
          description: 'Shown full width in the article. Upload at least 1400 px wide.',
          options: {hotspot: true},
          fields: [
            defineField({name: 'alt', title: 'Alt text', type: 'string'}),
            defineField({name: 'caption', type: 'string', description: 'Optional, shown under the image.'}),
          ],
        }),
        defineArrayMember({
          name: 'callout',
          title: 'Tip box',
          type: 'object',
          icon: BulbOutlineIcon,
          fields: [
            defineField({name: 'label', type: 'string', initialValue: 'Tip'}),
            defineField({name: 'text', type: 'text', rows: 3, validation: (r) => r.required()}),
          ],
          preview: {select: {title: 'label', subtitle: 'text'}},
        }),
        defineArrayMember({
          name: 'gallery',
          title: 'Image gallery',
          type: 'object',
          icon: ImagesIcon,
          fields: [
            defineField({
              name: 'images',
              title: 'Images',
              type: 'array',
              description:
                'Up to 10 images. Desktop shows up to 4 in a grid (with a "+ more" tile if there are more); phones show all of them in a swipeable carousel. Clicking an image opens the full-size viewer with every image. Upload at least 1600 px wide and set the hotspot so the subject stays in view.',
              of: [
                defineArrayMember({
                  type: 'image',
                  options: {hotspot: true},
                  fields: [
                    defineField({name: 'alt', title: 'Alt text', type: 'string', description: 'Describe the image for screen readers and Google.'}),
                    defineField({name: 'caption', type: 'string', description: 'Optional, shown when the image is opened full size.'}),
                  ],
                }),
              ],
              options: {layout: 'grid'},
              validation: (r) => r.required().min(1).max(10),
            }),
            defineField({
              name: 'caption',
              title: 'Gallery caption',
              type: 'string',
              description: 'Optional, shown under the gallery.',
            }),
          ],
          preview: {
            // Preview can't select a whole array, so check each of the 10 slots
            select: {
              ...Object.fromEntries(Array.from({length: 10}, (_, i) => [`i${i}`, `images.${i}.asset`])),
              caption: 'caption',
              media: 'images.0',
            },
            prepare: ({caption, media, ...slots}) => {
              const n = Object.values(slots).filter(Boolean).length
              return {title: `Image gallery · ${n} image${n === 1 ? '' : 's'}`, subtitle: caption, media}
            },
          },
        }),
        defineArrayMember({
          name: 'audio',
          title: 'Audio',
          type: 'object',
          icon: PlayIcon,
          fields: [
            defineField({
              name: 'file',
              title: 'Audio file',
              type: 'file',
              description: 'MP3 (128 kbps) or M4A. Keep clips under about 15 minutes; use a podcast host for full episodes.',
              options: {accept: 'audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,.mp3,.m4a'},
              validation: (r) => r.required(),
            }),
            defineField({
              name: 'title',
              type: 'string',
              description: 'e.g. "Listen: Sue on starting her kitchen"',
              validation: (r) => r.required(),
            }),
            defineField({
              name: 'caption',
              title: 'Caption or transcript',
              type: 'text',
              rows: 4,
              description: 'Optional. Long text (a transcript) is shown behind a "Read transcript" toggle.',
            }),
          ],
          preview: {
            select: {title: 'title', filename: 'file.asset.originalFilename'},
            prepare: ({title, filename}) => ({title: title || 'Audio', subtitle: filename, media: PlayIcon}),
          },
        }),
        defineArrayMember({
          name: 'video',
          title: 'Video',
          type: 'object',
          icon: VideoIcon,
          // One input for the whole block: shows what the link is (clip or Stream), a
          // thumbnail, and fills the hidden `aspect` field. See VideoLinkInput.jsx.
          components: {input: VideoLinkInput},
          fields: [
            defineField({
              name: 'link',
              title: 'Video link',
              type: 'string',
              description: 'A clip from admin.kedaipal.com/videos, or the link of a video on our YouTube channel.',
              validation: (r) =>
                r.required().custom(videoLinkError),
            }),
            // "W/H", e.g. "16/9" — written by VideoLinkInput from the clip's own size, so the
            // page can reserve the right box before the video loads. Stream is always 16/9.
            defineField({name: 'aspect', type: 'string', hidden: true}),
            defineField({
              name: 'poster',
              title: 'Poster',
              type: 'image',
              description:
                'Only if you want a different frame than the automatic one. It is cut to the video\'s shape, so set the crop and hotspot to keep the subject in view.',
              options: {hotspot: true},
              // No alt text: the poster is decorative. The video's title and caption carry its
              // meaning, and the play button is named after the title.
            }),
            defineField({
              name: 'title',
              type: 'string',
              description: 'Optional, e.g. "Watch: Sue on starting her kitchen". Shown in bold under the video.',
            }),
            defineField({
              name: 'caption',
              type: 'text',
              rows: 3,
              description: 'Optional, shown under the video.',
            }),
          ],
          preview: {
            select: {title: 'title', link: 'link', poster: 'poster'},
            prepare: videoPreview,
          },
        }),
        defineArrayMember({
          name: 'divider',
          title: 'Divider',
          type: 'object',
          fields: [defineField({name: 'style', type: 'string', hidden: true, initialValue: 'line'})],
          preview: {prepare: () => ({title: '——— Divider ———'})},
        }),
      ],
    }),
    defineField({
      name: 'coverText',
      title: 'Cover text',
      type: 'string',
      fieldset: 'noImage',
      description: 'Short, e.g. "Never lose an order."',
    }),
    defineField({
      name: 'coverStyle',
      title: 'Cover colour',
      type: 'string',
      fieldset: 'noImage',
      options: {
        list: [
          {title: 'Navy', value: 'navy'},
          {title: 'Light', value: 'light'},
          {title: 'Green', value: 'green'},
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'navy',
    }),
  ],
  orderings: [
    {title: 'Newest first', name: 'publishedDesc', by: [{field: 'publishedAt', direction: 'desc'}]},
  ],
  preview: {
    select: {title: 'title', category: 'category.title', date: 'publishedAt', media: 'mainImage'},
    prepare: ({title, category, date, media}) => ({
      title,
      subtitle: [category, date && new Date(date).toLocaleDateString('en-GB')].filter(Boolean).join(' · '),
      media,
    }),
  },
})

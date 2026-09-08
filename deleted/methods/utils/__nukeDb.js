// This method nukes the database and will probably be removed before release, it's just for testing purposes.

import {
  Activity,
  Bookmark,
  Circle,
  Group,
  React,
  Inbox,
  Outbox,
  Reply,
  File,
  Post,
  User,
  Settings,
  Page,
} from "#schema";

export default async function () {
  await Settings.deleteMany({});
  await Activity.deleteMany({});
  await Bookmark.deleteMany({});
  await Circle.deleteMany({});
  await Group.deleteMany({});
  await React.deleteMany({});
  await Reply.deleteMany({});
  await Page.deleteMany({});
  await Post.deleteMany({});
  await User.deleteMany({});
  await File.deleteMany({});
  await Inbox.deleteMany({});
  await Outbox.deleteMany({});
  return true;
}

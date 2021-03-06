"use strict";


var Gitter = require("node-gitter"),
    GitterHelper = require("../../lib/gitter/GitterHelper");

var AppConfig = require("../../config/AppConfig"),
    RoomData = require("../../data/RoomData"),
    Utils = require("../../lib/utils/Utils"),
    KBase = require("../../lib/bot/KBase"),
    BotCommands = require("../../lib/bot/BotCommands"),
    Bonfires = require("../app/Bonfires");

var RoomMessages = require("../../data/rooms/RoomMessages");

function clog(msg, obj) {
    Utils.clog("GBot>", msg, obj);
}

var GBot = {

    init: function() {
        // TODO refresh and add oneToOne rooms
        KBase.initSync();
        this.roomList = [];
        this.gitter = new Gitter(AppConfig.token);
        this.joinKnownRooms();
        this.joinBonfireRooms();
        this.scanRooms();
        BotCommands.init(this);
    },

    getName: function() {
        return AppConfig.botlist[0];
    },

    say: function(text, room) {
        Utils.hasProperty(room, 'path', 'expected room object'); // did we get a room
        try {
            room.send(text);
        } catch (err) {
            Utils.warn("GBot.say>", "failed", err);
            Utils.warn("GBot.say>", "room", room);
        }
    },

    // ---------------- room related ----------------


    // listen to a know room
    // does a check to see if not already joined according to internal data
    listenToRoom: function(room) {
        // gitter.rooms.find(room.id).then(function (room) {

        if (this.addToRoomList(room) === false) {
            return;
        }

        // Utils.clog("listenToRoom ->", room);
        var chats = room.streaming().chatMessages();
        // clog("listenToRoom ok:", room.name);

        // The 'chatMessages' event is emitted on each new message
        chats.on("chatMessages", function(message) {
            // clog('message> ', message.model.text);
            if (message.operation !== "create") {
                // console.log("skip msg reply", msg);
                return;
            }

            if (GBot.isBot(message.model.fromUser.username)) {
                // console.warn("skip reply to bot");
                return;
            }
            message.room = room; // why don't gitter do this?
            GBot.handleReply(message);
        });
    },

    // main IO routine called from room listener
    // TODO - add roomName info for the logs
    handleReply: function(message) {
        clog(message.room.uri + " @" + message.model.fromUser.username + ":");
        clog(" in|",  message.model.text);
        var output = this.findAnyReply(message);
        clog("out| ", output);
        this.say(output, message.room);
        // message.room.send(output);
        return (output);
    },

    // search all reply methods
    // returns a string to send
    // handleReply takes care of sending to chat system
    findAnyReply: function(message) {
        var input, output;
        input = this.parseInput(message);
        if (input.command) {
            // this looks up a command and calls it
            output = BotCommands[input.keyword](input, this);
        } else {
            // non-command keywords like 'troll'
            output = RoomMessages.scanInput(input, input.message.room.name, AppConfig.botNoiseLevel);
        }
        return output;
    },

    // turns raw text input into a json format
    parseInput: function(message) {
        Utils.hasProperty(message, 'model');
        var cleanText, input;

        cleanText = message.model.text;
        cleanText = Utils.sanitize(cleanText);

        input = Utils.splitParams(cleanText);
        input = this.cleanInput(input);
        input.message = message;
        input.cleanText = cleanText;

        if (BotCommands.isCommand(input)) {
            input.command = true;
        }

        // check for regex based commands
        // if message.test( /.*thanks.*/ )
        // ... input.command = true;
        //      input.keyword = "thanks"


        // clog("input", message.model.text);
        return input;
    },

    cleanInput: function(input) {
        // 'bot' keyword is an object = bad things happen when called as a command
        if (input.keyword == 'bot') {
            input.keyword = 'help';
        }
        return input;
    },

    announce: function(opts) {
        clog("announce", opts);
        // this.scanRooms();
        // Utils.clog("announce -->", opts);
        this.joinRoom(opts, true);
        // Utils.clog("announce <ok", opts);
    },

    joinRoom: function(opts, announceFlag) {
        var roomUrl = opts.roomObj.name;

        GBot.gitter.rooms.join(roomUrl, function(err, room) {
            if (err) {
                console.warn("Not possible to join the room: ", err, roomUrl);
                // return null; // check - will this add nulls to the list of rooms?
            }
            GBot.roomList.push(room);
            GBot.listenToRoom(room);
            var text = GBot.getAnnounceMessage(opts);
            GBot.say(text, room);
            // clog("joined> ", room.uri);
            return room;
        });
        return false;
    },

    // checks if joined already, otherwise adds
    addToRoomList: function(room) {
        // check for dupes
        this.roomList = this.roomList || [];
        if (this.hasAlreadyJoined(room, this.roomList)) {
            return false;
        }

        // clog("addToRoomList>", room.name);
        this.roomList.push(room);
        return true;
    },

    // checks if a room is already in bots internal list of joined rooms
    // this is to avoid listening twice
    // see https://github.com/gitterHQ/node-gitter/issues/15
    // note this is only the bots internal tracking
    // it has no concept if the gitter API/state already thinks you're joined/listening
    hasAlreadyJoined: function(room) {
        var checks = this.roomList.filter(function(rm) {
            return (rm.name === room.name);
        });
        var oneRoom = checks[0];
        if (oneRoom) {
            Utils.warn("GBot", "hasAlreadyJoined:", oneRoom.url);
            return true;
        }
        return false;
    },

    getAnnounceMessage: function(opts) {
        return "";
        // disable
        var text = "----\n";
        if (opts.who && opts.topic) {
            text += "@" + opts.who + " has a question on\n";
            text += "## " + opts.topic;
        } else if (opts.topic) {
            text += "a question on: **" + opts.topic + "**";
        } else if (opts.who) {
            text += "welcome @" + opts.who;
        }
        return text;
    },

    // dont reply to bots or you'll get a feedback loop
    isBot: function(who) {
        for (var bot of AppConfig.botlist) {
            if (who === bot) {
                //Utils.warn("GBot", "isBot!");
                return true;
            }
        }
        return false;
    },

    // this joins rooms contained in the data/RoomData.js file
    // ie a set of bot specific discussion rooms
    joinKnownRooms: function() {
        var that = this;
        clog("botname on rooms", AppConfig.getBotName() );
        RoomData.rooms().map(function(oneRoomData) {
            var roomUrl = oneRoomData.name;
            // clog("oneRoomData", oneRoomData);
            // clog("gitter.rooms", that.gitter.rooms);
            that.gitter.rooms.join(roomUrl, function(err, room) {
                if (err) {
                    // Utils.warn("Not possible to join the room:", err, roomUrl);
                    return;
                }
                that.listenToRoom(room);
                clog("joined> ", room.name);
            });
        });
    },


    joinBonfireRooms: function() {
        var that = this;
        Bonfires.allDashedNames().map(function(name) {
            var roomUrl = AppConfig.getBotName() + "/" + name;
            // Utils.clog("bf room", roomUrl);
            that.gitter.rooms.join(roomUrl, function(err, room) {
                if (err) {
                    // Utils.warn("Not possible to join the room:", err, roomUrl);
                    return;
                }
                that.listenToRoom(room);
            });
        });
    },

    // uses gitter helper to fetch the list of rooms this user is "in"
    // and then tries to listen to them
    // this is mainly to pick up new oneOnOne conversations
    // when a user DMs the bot
    // as I can't see an event the bot would get to know about that
    // so its kind of like "polling" and currently only called from the webUI
    scanRooms: function(user, token) {
        user = user || this.gitter.currentUser();
        token = token || AppConfig.token;

        clog("user", user);
        clog("token", token);
        var that = this;

        GitterHelper.fetchRooms(user, token, function(err, rooms) {
            if (err) {
                Utils.warn("GBot", "fetchRooms", err);
            }
            if (!rooms) {
                Utils.warn("cant scanRooms");
                return;
            }
            // else
            clog("scanRooms.rooms", rooms);
            rooms.map(function(room) {
                if (room.oneToOne) {
                    clog("oneToOne", room.name);
                    that.gitter.rooms.find(room.id)
                        .then(function(roomObj) {
                            that.listenToRoom(roomObj);
                        });
                }
            });
        });
    },

    // FIXME doesnt work for some reason >.<
    // needs different type of token?
    updateRooms: function() {
        GBot.gitter.currentUser()
            .then(function(user) {
                var list = user.rooms(function(err, obj) {
                    clog("rooms", err, obj);
                });
                clog("user", user);
                clog("list", list);
                return (list);
            });
    }

};

module.exports = GBot;



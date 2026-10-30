//! Independent stream histories share one token-major table gather without sharing their hash state.
const std = @import("std");

pub const Window = struct { history: []i64, tokens: []const u32 };

pub fn enabled() bool {
    const value = std.c.getenv("TF_FLASHNEXT_PLE_BATCH") orelse return true;
    return !std.mem.eql(u8, std.mem.span(value), "0");
}

pub fn rows(g: anytype, windows: []const Window, out: []u16, xs: []f32) !void {
    if (windows.len == 0 or windows.len > 32) return error.UnexpectedTensor;
    const h = g.hash.n - 1;
    if (h > 8) return error.UnexpectedTensor;
    var total: usize = 0;
    for (windows, 0..) |w, i| {
        if (w.history.len != h or w.tokens.len == 0) return error.UnexpectedTensor;
        for (windows[0..i]) |prior| {
            const begin = @intFromPtr(w.history.ptr);
            const other = @intFromPtr(prior.history.ptr);
            if (begin < other + h * 8 and other < begin + h * 8) return error.UnexpectedTensor;
        }
        total += w.tokens.len;
    }
    if (out.len != total * g.width() or xs.len != out.len / 32) return error.UnexpectedTensor;
    const ids = try g.gpa.alloc(i64, total * g.hash.heads);
    defer g.gpa.free(ids);
    var histories: [32][8]i64 = undefined;
    var at: usize = 0;
    for (windows, 0..) |w, i| {
        const n = w.tokens.len * g.hash.heads;
        try g.prepareRows(w.history, w.tokens, ids[at..][0..n], histories[i][0..h]);
        at += n;
    }
    try g.gatherIds(ids, out, xs);
    for (windows, 0..) |w, i| @memcpy(w.history, histories[i][0..h]);
}

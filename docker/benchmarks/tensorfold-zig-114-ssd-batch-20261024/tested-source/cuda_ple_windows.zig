//! Independent stream histories share one token-major table gather without sharing their hash state.
const std = @import("std");
const ple = @import("cuda_ple.zig");
const pool = @import("cuda_ple_pool.zig");

pub const Window = struct { history: []i64, tokens: []const u32 };

pub fn enabled() bool {
    const value = std.c.getenv("TF_FLASHNEXT_PLE_BATCH") orelse return true;
    return !std.mem.eql(u8, std.mem.span(value), "0");
}

/// Groups a shared pass; single windows and the explicit control use the upstream path.
pub fn gather(g: anytype) !bool {
    if (g.lanes.len <= 1 or g.lanes.len > 32 or !enabled()) return false;
    var windows: [32]Window = undefined;
    var row: usize = 0;
    for (g.lanes, 0..) |l, i| {
        windows[i] = .{ .history = l.seq.history[0..], .tokens = g.ids[row..][0..l.rows] };
        row += l.rows;
    }
    try g.ngram.rowsMany(windows[0..g.lanes.len], g.emb, g.xs);
    return true;
}

pub fn rows(g: anytype, windows: []const Window, out: []u16, xs: []f32) !void {
    if (windows.len == 0 or windows.len > 32) return error.UnexpectedTensor;
    const h = g.hash.n - 1;
    if (h >= ple.max_n) return error.UnexpectedTensor;
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
    var histories: [32][ple.max_n]i64 = undefined;
    var at: usize = 0;
    for (windows, 0..) |w, i| {
        const n = w.tokens.len * g.hash.heads;
        @memcpy(histories[i][0..h], w.history);
        for (w.tokens, 0..) |token, t| {
            try ple.lastIds(g.hash, histories[i][0..h], @intCast(token), ids[at + t * g.hash.heads ..][0..g.hash.heads]);
            for (0..h - 1) |j| histories[i][j] = histories[i][j + 1];
            histories[i][h - 1] = token;
        }
        at += n;
    }
    try gatherIds(g, ids, out, xs);
    for (windows, 0..) |w, i| @memcpy(w.history, histories[i][0..h]);
}

const Split = struct {
    g: *const ple.Ngram,
    ids: []const i64,
    out: []u16,
    per: usize,

    fn part(ctx: *const anyopaque, i: usize) anyerror!void {
        const s: *const Split = @ptrCast(@alignCast(ctx));
        const lo = @min(s.ids.len, i * s.per);
        try s.g.fill(s.ids, s.out, lo, @min(s.ids.len, lo + s.per));
    }
};

fn gatherIds(g: *const ple.Ngram, ids: []const i64, out: []u16, xs: []f32) !void {
    const items = ids.len;
    const width = g.width();
    const parts = @min(pool.max_parts, items / 4);
    if (parts <= 1 or g.pool == null) {
        try g.fill(ids, out, 0, items);
    } else {
        const split: Split = .{ .g = g, .ids = ids, .out = out, .per = (items + parts - 1) / parts };
        try g.pool.?.run(parts, .{ .ctx = &split, .run = Split.part });
    }
    for (0..items / g.hash.heads) |t| {
        const row = out[t * width ..][0..width];
        if (g.format == .mlx and g.scale != 1) {
            for (row) |*v| {
                const f: f32 = @bitCast(@as(u32, v.*) << 16);
                v.* = ple.toBf16(f * g.scale);
            }
        }
        ple.sumGroups(row, xs[t * (width / 32) ..][0 .. width / 32]);
    }
}
